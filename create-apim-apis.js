require('dotenv').config();
const axios = require('axios');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const {
  SUBSCRIPTION_ID,
  RESOURCE_GROUP,
  APIM_NAME,
  AZURE_ACCESS_TOKEN,
  SHEET_NUM,
  GATEWAY_NAME
} = process.env;

const apiVersion = '2022-08-01';
const tagApiVersion = '2024-05-01';
const excelFilePath = 'mashery.xlsx';
const failedFilePath = 'failed_apis.xlsx';

const logDir = './logs';
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const infoLogFile = path.join(logDir, 'info.log');
const errorLogFile = path.join(logDir, 'error.log');

function logInfo(message) {
  const timestamp = new Date().toISOString();
  const formatted = `[INFO]  ${timestamp} - ${message}\n`;
  process.stdout.write(formatted);
  fs.appendFileSync(infoLogFile, formatted);
}

function logError(message) {
  const timestamp = new Date().toISOString();
  const formatted = `[ERROR] ${timestamp} - ${message}\n`;
  process.stderr.write(formatted);
  fs.appendFileSync(errorLogFile, formatted);
}

function parseExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[SHEET_NUM];
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
}

function writeFailedRows(rows) {
  if (!rows.length) return;
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Failed APIs");
  XLSX.writeFile(wb, failedFilePath);
  console.log(`\n❗ ${rows.length} failed API rows written to '${failedFilePath}'`);
  logError(`\n❗ ${rows.length} failed API rows written to '${failedFilePath}'`);
}

function sanitizeId(value) {
  return value
    ?.toLowerCase()
    ?.replace(/[^a-z0-9-]+/g, '-')
    ?.replace(/^-+|-+$/g, '')
    ?.replace(/-+/g, '-');
}

async function ensureProductExists(token, productId, productName) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/products/${productId}?api-version=${apiVersion}`;
  try {
    await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    logInfo(`ℹ️ PRODUCT '${productId}' ==> exists.`);
  } catch (err) {
    if (err.response?.status === 404) {
      const payload = {
        properties: {
          displayName: productName,
          description: `Auto-created for ${productName}`,
          terms: 'Auto-generated terms',
          subscriptionRequired: true,
          state: 'published'
        }
      };
      await axios.put(url, payload, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      logInfo(`✅ PRODUCT '${productId}' ==> created.`);
    } else {
      throw new Error(`Failed to ensure product '${productId}': ${err.message}`);
    }
  }
}

async function assignApiToMultipleProducts(token, apiId, packageNameString) {
  const productNames = (packageNameString || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  for (const productName of productNames) {
    const productId = sanitizeId(productName);
    try {
      await ensureProductExists(token, productId, productName);
      const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/products/${productId}/apis/${apiId}?api-version=${apiVersion}`;
      await axios.put(url, null, {
        headers: { Authorization: `Bearer ${token}` }
      });
      logInfo(`📦 API '${apiId}' ==> assigned to product '${productId}'.`);
    } catch (err) {
      logError(`❌ Failed to assign API '${apiId}' to product '${productName}': ${err.message}`);
    }
  }
}

function extractDomainTags(config) {
  const tags = new Set();
  // if (config.publicDomains) {
  //   config.publicDomains.split(',').forEach(domain => {
  //     const match = domain.trim().match(/^([a-zA-Z0-9-]+)\./);
  //     if (match) tags.add(match[1]);
  //   });
  // }
  if (config.Organization) {
    tags.add(config.Organization.trim());
  }
  return Array.from(tags);
}

async function ensureApiTagExists(token, tagId, displayName) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/tags/${tagId}?api-version=${tagApiVersion}`;
  const payload = { properties: { displayName } };
  await axios.put(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  logInfo(`📅 TAG '${tagId}' ==> ensured.`);
}

async function assignTagToApi(token, apiId, tagId) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/apis/${apiId}/tags/${tagId}?api-version=${tagApiVersion}`;
  await axios.put(url, null, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  logInfo(`🌿 TAG '${tagId}' ==> assigned to API '${apiId}'.`);
}

async function createApi(token, config, apiId) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/apis/${apiId}?api-version=${apiVersion}`;
  const payload = {
    properties: {
      displayName: config.APIName,
      path: `${config.urlSuffix?.replace(/^\//, '')}`,
      protocols: ['http', 'https'],
      serviceUrl: `${config.outboundTransportProtocol}://${config.systemDomains?.replace(/\/+$/, '')}`,
      description: config.description || '',
      subscriptionRequired: true
    }
  };
  await axios.put(url, payload, {
    headers: { Authorization: `Bearer ${token}` }
  });
  logInfo(`✅ API '${apiId}' ==> created.`);

  const tags = extractDomainTags(config);
  for (const tag of tags) {
    const tagId = sanitizeId(tag);
    try {
      await ensureApiTagExists(token, tagId, tag);
      await assignTagToApi(token, apiId, tagId);
    } catch (err) {
      logError(`⚠️ Failed to create/assign tag '${tag}' to API '${apiId}': ${err.message}`);
    }
  }
}

async function updateSubscriptionKeyHeader(token, config, apiId) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/apis/${apiId}?api-version=${apiVersion}`;
  const payload = {
    properties: {
      subscriptionKeyParameterNames: {
        header: config.apiKeyValueLocationKey,
        query: 'subscription-key'
      }
    }
  };
  await axios.patch(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  logInfo(`🔑 Subscription key header updated for API '${apiId}' ==> to ${config.apiKeyValueLocationKey}.`);
}

async function assignApiToGateway(token, apiId, gatewayId = GATEWAY_NAME) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/gateways/${gatewayId}/apis/${apiId}?api-version=${apiVersion}`;
  await axios.put(url, null, {
    headers: { Authorization: `Bearer ${token}` }
  });
  logInfo(`✅ API '${apiId}' ==> assigned to gateway '${gatewayId}'.`);
}

async function removeFromManagedGateway(token, apiId) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/gateways/managed/apis/${apiId}?api-version=${apiVersion}`;
  try {
    await axios.delete(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    logInfo(`🚫 API '${apiId}' ==> removed from managed gateway.`);
  } catch (err) {
    if (err.response?.status === 404) {
      logInfo(`ℹ️ '${apiId}' ==> not assigned to managed gateway.`);
    } else {
      logError(`⚠️ Error removing from managed gateway: ${err.message}`);
    }
  }
}

async function createOperationsAndPolicies(token, apiId, config) {
  const methods = (config.supportedHttpMethods || 'GET')
    .split(',')
    .map(m => m.trim().toUpperCase())
    .filter(Boolean);

  for (const method of methods) {
    const operationId = sanitizeId(`${method}-${config.EndpointName}`);
    const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/apis/${apiId}/operations/${operationId}?api-version=${apiVersion}`;
    const operationPath = config.operationPath || '/';

    const paramNames = (operationPath.match(/{([^}]+)}/g) || []).map(p => p.slice(1, -1));
    const templateParameters = paramNames.map(name => ({
      name,
      type: 'string',
      required: true,
      description: name
    }));

    const payload = {
      properties: {
        displayName: `${config.EndpointName}`,
        method,
        urlTemplate: operationPath,
        responses: [{ statusCode: 200, description: 'OK' }]
      }
    };
    if (templateParameters.length > 0) {
      payload.properties.templateParameters = templateParameters;
    }

    try {
      await axios.put(url, payload, {
        headers: { Authorization: `Bearer ${token}` }
      });
      logInfo(`✅ OPERATION '${operationId}' ==> created.`);
      await applyPolicy(token, apiId, operationId, config, method);
    } catch (err) {
      logError(`⚠️ Failed to create operation/policy '${operationId}' on API '${apiId}': ${err.message}`);
    }
  }
}

async function applyPolicy(token, apiId, operationId, config, method) {
  const rateLimitCeiling = config.rateLimitCeiling || 0;
  const rateLimitPeriod = (config.rateLimitPeriod || '').toLowerCase();
  const qpsLimitCeiling = config.qpsLimitCeiling || 0;
  const rewritePath = config.outboundRequestTargetPath || '/';

  const periodToSeconds = { minute: 60, hour: 3600, day: 86400 };
  const renewalPeriodSec = periodToSeconds[rateLimitPeriod] || 0;

  let inboundPolicies = `    <base />\n    <rewrite-uri template="${rewritePath}" />\n`;

  if (rateLimitCeiling > 0 && renewalPeriodSec >= 300) {
    inboundPolicies += `    <quota-by-key calls="${rateLimitCeiling}" renewal-period="${renewalPeriodSec}" counter-key="@(context.Subscription.Key)" />\n`;
  }
  if (qpsLimitCeiling > 0) {
    inboundPolicies += `    <rate-limit-by-key calls="${qpsLimitCeiling}" renewal-period="1" counter-key="@(context.Subscription.Key)" />\n`;
  }

  const policyXml = `<policies>
  <inbound>
${inboundPolicies}  </inbound>
  <backend><base /></backend>
  <outbound><base /></outbound>
</policies>`;

  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/apis/${apiId}/operations/${operationId}/policies/policy?api-version=${apiVersion}`;

  await axios.put(
    url,
    { properties: { format: 'rawxml', value: policyXml } },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );

  console.log(`✅ Policy applied to '${operationId}' (${method})`);
}

// ==== MAIN LOGIC ====
(async () => {
  try {
    const token = AZURE_ACCESS_TOKEN;
    if (!token) throw new Error("AZURE_ACCESS_TOKEN is missing.");
    const configs = parseExcel(excelFilePath);
    const createdApis = new Set();
    const failedRows = [];

    for (const config of configs) {
      const apiId = sanitizeId(config.APIName);
      try {
        if (!createdApis.has(apiId)) {
          await createApi(token, config, apiId);
          await updateSubscriptionKeyHeader(token, config, apiId);
          await assignApiToGateway(token, apiId);
          await removeFromManagedGateway(token, apiId);

          // Assign API to multiple products from packageName column
          await assignApiToMultipleProducts(token, apiId, config.packageName);

          createdApis.add(apiId);
        }
      } catch (apiError) {
        failedRows.push({ ...config, _error: apiError.message });
        console.error(`❌ Failed MAIN API steps for "${config.APIName}": ${apiError.message}`);
        logError(`❌ Failed MAIN API steps for "${config.APIName}": ${apiError.message}`);
        continue;
      }

      await createOperationsAndPolicies(token, apiId, config);
      logInfo(`=========<<<<<=${config.EndpointName}=>>>>>>>> DONE !!!!!!>`);
    }

    writeFailedRows(failedRows);
  } catch (error) {
    console.error("❌ Script error:", error.message);
    logError("❌ Script error:", error.message);
  }
})();
