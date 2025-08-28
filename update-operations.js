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
  SHEET_NUM
} = process.env;

const apiVersion = '2022-08-01';
const excelFilePath = 'mashery.xlsx';
const logDir = './logs';
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const infoLogFile = path.join(logDir, 'update_info.log');
const errorLogFile = path.join(logDir, 'update_error.log');

function logInfo(msg) {
  const formatted = `[INFO] ${new Date().toISOString()} - ${msg}\n`;
  process.stdout.write(formatted);
  fs.appendFileSync(infoLogFile, formatted);
}

function logError(msg) {
  const formatted = `[ERROR] ${new Date().toISOString()} - ${msg}\n`;
  process.stderr.write(formatted);
  fs.appendFileSync(errorLogFile, formatted);
}

function parseExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[SHEET_NUM];
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
}

function sanitizeId(value) {
  return value?.toLowerCase()
    ?.replace(/[^a-z0-9-]+/g, '-')
    ?.replace(/^-+|-+$/g, '')
    ?.replace(/-+/g, '-');
}

function adjustOperationPath(pathValue) {
  let opPath = pathValue || '/';
  // Always ensure trailing wildcard for deep matching
  if (opPath === '/' || opPath.endsWith('/')) {
    opPath = opPath.replace(/\/+$/, '') + '/{*path}';
  }
  return opPath;
}

async function updateOperation(token, apiId, config) {
  const methods = (config.supportedHttpMethods || 'GET')
    .split(',')
    .map(m => m.trim().toUpperCase())
    .filter(Boolean);

  for (const method of methods) {
    const operationId = sanitizeId(`${method}-${config.EndpointName}`);
    const operationPath = adjustOperationPath(config.operationPath);

    // Extract template params
    const paramNames = (operationPath.match(/{\*?([^}]+)}/g) || []).map(p => p.replace(/[{}*]/g, ''));
    const templateParameters = paramNames.map(name => ({
      name,
      type: 'string',
      required: false,
      description: `Parameter ${name}`
    }));

    const opUrl = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/apis/${apiId}/operations/${operationId}?api-version=${apiVersion}`;

    const payload = {
      properties: {
        displayName: config.EndpointName,
        method,
        urlTemplate: operationPath,
        responses: [{ statusCode: 200, description: 'OK' }],
        templateParameters // ensure all parameters are defined
      }
    };

    try {
      await axios.put(opUrl, payload, { headers: { Authorization: `Bearer ${token}` } });
      logInfo(`✅ Operation '${operationId}' updated with path '${operationPath}'.`);
      await applyRewritePolicy(token, apiId, operationId, config);
    } catch (err) {
      logError(`❌ Failed to update operation '${operationId}': ${err.message}`);
    }
  }
}


async function applyRewritePolicy(token, apiId, operationId, config) {
  const rewriteBase = config.outboundRequestTargetPath?.replace(/\/+$/, '') || '';
  const rateLimitCeiling = config.rateLimitCeiling || 0;
  const rateLimitPeriod = (config.rateLimitPeriod || '').toLowerCase();
  const qpsLimitCeiling = config.qpsLimitCeiling || 0;

  const periodToSeconds = { minute: 60, hour: 3600, day: 86400 };
  const renewalPeriodSec = periodToSeconds[rateLimitPeriod] || 0;

  // Build inbound policies
  let inboundPolicies = `    <base />\n`;
  inboundPolicies += `    <set-variable name="rewriteBase" value="${rewriteBase}" />\n`;
  inboundPolicies += `    <rewrite-uri template="@((string)context.Variables["rewriteBase"] + context.Request.MatchedParameters["path"])" />\n`;

  if (rateLimitCeiling > 0 && renewalPeriodSec >= 300) {
    inboundPolicies += `    <quota-by-key calls="${rateLimitCeiling}" renewal-period="${renewalPeriodSec}" counter-key="@(context.Subscription.Key)" />\n`;
  }
  if (qpsLimitCeiling > 0) {
    inboundPolicies += `    <rate-limit-by-key calls="${qpsLimitCeiling}" renewal-period="1" counter-key="@(context.Subscription.Key)" />\n`;
  }

  // Full policy XML
  const policyXml = `<policies>
  <inbound>
${inboundPolicies}  </inbound>
  <backend>
    <base />
  </backend>
  <outbound>
    <base />
  </outbound>
</policies>`;

  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/apis/${apiId}/operations/${operationId}/policies/policy?api-version=${apiVersion}`;

  try {
    await axios.put(
      url,
      { properties: { format: 'rawxml', value: policyXml } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    logInfo(`✅ Rewrite + quota/rate-limit policy applied to operation '${operationId}' (base: '${rewriteBase}').`);
  } catch (err) {
    logError(`❌ Failed to apply policy to '${operationId}': ${err.message}`);
  }
}



(async () => {
  try {
    const token = AZURE_ACCESS_TOKEN;
    if (!token) throw new Error("AZURE_ACCESS_TOKEN is missing.");
    const configs = parseExcel(excelFilePath);
    const failedOps = [];

    for (const config of configs) {
      const apiId = sanitizeId(config.APIName);
      try {
        await updateOperation(token, apiId, config);
      } catch (err) {
        failedOps.push({ ...config, _error: err.message });
        logError(`❌ Failed update for '${config.APIName}': ${err.message}`);
      }
    }

    if (failedOps.length) {
      const ws = XLSX.utils.json_to_sheet(failedOps);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Failed Operations");
      XLSX.writeFile(wb, 'failed_operations.xlsx');
      console.log(`\n❗ ${failedOps.length} failed operations written to 'failed_operations.xlsx'`);
    }

    console.log("\n🎯 Operation updates completed.");
  } catch (err) {
    console.error("❌ Script error:", err.message);
    logError(`❌ Script error: ${err.message}`);
  }
})();
