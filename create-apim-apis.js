require('dotenv').config();
const axios = require('axios');
const XLSX = require('xlsx');

const {
  SUBSCRIPTION_ID,
  RESOURCE_GROUP,
  APIM_NAME,
  AZURE_ACCESS_TOKEN
} = process.env;

const apiVersion = '2022-08-01';
const tagApiVersion = '2024-05-01';
const excelFilePath = 'mashery.xlsx';
const failedFilePath = 'failed_apis.xlsx';   // <---- failed rows here

function parseExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
}

function writeFailedRows(rows) {
  if (!rows.length) return;
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Failed APIs");
  XLSX.writeFile(wb, failedFilePath);
  console.log(`\n❗ ${rows.length} failed API rows written to '${failedFilePath}'`);
}

function sanitizeId(value) {
  return value
    ?.toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

// All async functions below are unchanged from your script.

async function ensureProductExists(token, productId, productName) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/products/${productId}?api-version=${apiVersion}`;
  try {
    await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    console.log(`ℹ️ PRODUCT '${productId}' ==> exists.`);
  } catch (err) {
    if (err.response?.status === 404) {
      const payload = {
        properties: {
          displayName: productName,
          description: `Auto-created for ${productName}`,
          terms: 'Auto-generated terms',
          subscriptionRequired: false,
          state: 'published'
        }
      };
      await axios.put(url, payload, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      console.log(`✅ PRODUCT '${productId}' ==> created.`);
    } else {
      throw new Error(`Failed to ensure product '${productId}': ${err.message}`);
    }
  }
}

async function assignApiToProduct(token, apiId, productId) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/products/${productId}/apis/${apiId}?api-version=${apiVersion}`;
  await axios.put(url, null, {
    headers: { Authorization: `Bearer ${token}` }
  });
  console.log(`📦 API '${apiId}' ==>  assigned to product '${productId}'.`);
}

function extractDomainTags(config) {
  const tags = new Set();
  if (config.publicDomains) {
    config.publicDomains.split(',').forEach(domain => {
      const match = domain.trim().match(/^([a-zA-Z0-9-]+)\./);
      if (match) tags.add(match[1]);
    });
  }
  if (config.systemDomains) {
    config.systemDomains.split(',').forEach(domain => {
      const match = domain.trim().match(/^([a-zA-Z0-9-]+)\./);
      if (match) tags.add(match[1]);
    });
  }
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
  console.log(`📅 TAG '${tagId}' ==> ensured.`);
}

async function assignTagToApi(token, apiId, tagId) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/apis/${apiId}/tags/${tagId}?api-version=${tagApiVersion}`;
  await axios.put(url, null, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  console.log(`🌿 TAG '${tagId}' ==> assigned to API '${apiId}'.`);
}

async function createApi(token, config, apiId) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/apis/${apiId}?api-version=${apiVersion}`;
  const payload = {
    properties: {
      displayName: config.APIName,
      path: `${config.urlSuffix?.replace(/^\//, '')}`,
      protocols: ['http', 'https'],
      serviceUrl: `${config.outboundTransportProtocol}://${config.systemDomains.replace(/\/+$/, '')}`,
      description: config.description || '',
      subscriptionRequired: false
    }
  };
  await axios.put(url, payload, {
    headers: { Authorization: `Bearer ${token}` }
  });

  console.log(`✅ API '${apiId}' ==> created.`);

  // Tags
  const tags = extractDomainTags(config);
  for (const tag of tags) {
    const tagId = sanitizeId(tag);
    try {
      await ensureApiTagExists(token, tagId, tag);
      await assignTagToApi(token, apiId, tagId);
    } catch (err) {
      console.warn(`⚠️ Failed to create/assign tag '${tag}' to API '${apiId}': ${err.message}`);
      // Not failing the API for tag issues
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
  console.log(`🔑 Subscription key header updated for API '${apiId}' ==> to ${config.apiKeyValueLocationKey}.`);
}

async function assignApiToGateway(token, apiId, gatewayId = 'swarm-vm-gw') {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/gateways/${gatewayId}/apis/${apiId}?api-version=${apiVersion}`;
  await axios.put(url, null, {
    headers: { Authorization: `Bearer ${token}` }
  });
  console.log(`✅ API '${apiId}' ==> assigned to gateway '${gatewayId}'.`);
}

async function removeFromManagedGateway(token, apiId) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/gateways/managed/apis/${apiId}?api-version=${apiVersion}`;
  try {
    await axios.delete(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`🚫 API '${apiId}' ==> removed from managed gateway.`);
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`ℹ️ '${apiId}' ==> not assigned to managed gateway.`);
    } else {
      console.warn(`⚠️ Error removing from managed gateway: ${err.message}`);
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

    // Extract parameters from the path: {paramName}
    const paramNames = (operationPath.match(/{([^}]+)}/g) || []).map(p => p.slice(1, -1));

    // Build templateParameters array for APIM
    const templateParameters = paramNames.map(name => ({
      name,
      type: 'string',          // Adjust type as needed; string is most common
      required: true,
      description: name        // You can customize description if needed
    }));

    const payload = {
      properties: {
        displayName: `${config.EndpointName}`,
        method,
        urlTemplate: operationPath,
        responses: [{ statusCode: 200, description: 'OK' }]
      }
    };

    // Inject templateParameters only if needed
    if (templateParameters.length > 0) {
      payload.properties.templateParameters = templateParameters;
    }

    try {
      await axios.put(url, payload, {
        headers: { Authorization: `Bearer ${token}` }
      });
      console.log(`✅ OPERATION '${operationId}' ==> created.`);
      await applyPolicy(token, apiId, operationId, config, method);
    } catch (err) {
      console.warn(`⚠️ Failed to create operation/policy '${operationId}' on API '${apiId}': ${err.message}`);
      // Do not fail the API on operation failure; indicate in log.
    }
  }
}

async function applyPolicy(token, apiId, operationId, config, method) {
  const rateLimit = config.rateLimitCeiling || '10';
  const renewalPeriod = '60';
  const rewritePath = config.outboundRequestTargetPath || '/';
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/apis/${apiId}/operations/${operationId}/policies/policy?api-version=${apiVersion}`;
  const policyXml = `
    <policies>
      <inbound>
        <base />
        <rewrite-uri template="${rewritePath}" />
        <rate-limit-by-key calls="${rateLimit}" renewal-period="${renewalPeriod}"
          counter-key="@(context.Subscription?.Id ?? context.Request.IpAddress)" />
      </inbound>
      <backend><base /></backend>
      <outbound><base /></outbound>
    </policies>`;
  await axios.put(url, {
    properties: { format: 'rawxml', value: policyXml }
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  console.log(`✅ POLICY applied to '${operationId}' ==> (${method})`);
}

// ==== MAIN LOGIC WITH ERROR CAPTURE AND CONTINUATION ====

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
          const productId = sanitizeId(config.packageName || 'default-product');
          await ensureProductExists(token, productId, config.packageName || 'Default Product');
          await assignApiToProduct(token, apiId, productId);
          createdApis.add(apiId);
        }
      } catch (apiError) {
        // Record failed row (whole config)
        failedRows.push({ ...config, _error: apiError.message });
        console.error(`❌ Failed MAIN API steps for "${config.APIName}": ${apiError.message}`);
        continue; // Go to next API
      }

      // Operations and policies are NOT treated as critical, proceed even on partial failure
      await createOperationsAndPolicies(token, apiId, config);

      console.log(`=========<<<<<=${config.EndpointName}=>>>>>>>> DONE !!!!!!>`)
    }

    // Save failed rows if any
    writeFailedRows(failedRows);

  } catch (error) {
    console.error("❌ Script error:", error.message);
  }
})();
