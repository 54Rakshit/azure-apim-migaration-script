require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const csv = require('csv-parser');

const {
  SUBSCRIPTION_ID,
  RESOURCE_GROUP,
  APIM_NAME,
  AZURE_ACCESS_TOKEN
} = process.env;

const apiVersion = '2022-08-01';
const csvFilePath = 'input.csv';

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const records = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', data => records.push(data))
      .on('end', () => resolve(records))
      .on('error', err => reject(err));
  });
}

async function createApi(token, config) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/apis/${config.apiId}?api-version=${apiVersion}`;

  const payload = {
    properties: {
      displayName: config.apiDisplayName,
      path: config.apiPath,
      protocols: [config.protocols],
      serviceUrl: config.serviceUrl,
      description: config.apiDescription,
      subscriptionRequired: false
    }
  };

  await axios.put(url, payload, {
    headers: { Authorization: `Bearer ${token}` }
  });

  console.log(`✅ API '${config.apiId}' created.`);
}

async function assignApiToGateway(token, config) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/gateways/${config.gatewayId}/apis/${config.apiId}?api-version=${apiVersion}`;

  await axios.put(url, null, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  console.log(`✅ API '${config.apiId}' assigned to self-hosted gateway '${config.gatewayId}'.`);
}

async function removeFromManagedGateway(token, config) {
  const gatewayId = 'managed'; // Azure's default gateway ID
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/gateways/${gatewayId}/apis/${config.apiId}?api-version=${apiVersion}`;

  try {
    await axios.delete(url, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    console.log(`🚫 API '${config.apiId}' removed from managed gateway '${gatewayId}'.`);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.log(`ℹ️ API '${config.apiId}' was not assigned to managed gateway.`);
    } else {
      console.warn(`⚠️ Failed to remove API '${config.apiId}' from managed gateway:`, error.message);
    }
  }
}


async function createOperation(token, config) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/apis/${config.apiId}/operations/${config.operationId}?api-version=${apiVersion}`;

  const payload = {
    properties: {
      displayName: config.operationId,
      method: config.method,
      urlTemplate: config.urlTemplate,
      responses: [
        {
          statusCode: parseInt(config.responseStatusCode),
          description: config.responseDescription
        }
      ]
    }
  };

  await axios.put(url, payload, {
    headers: { Authorization: `Bearer ${token}` }
  });

  console.log(`✅ Operation '${config.operationId}' created.`);
}

async function applyRewritePolicy(token, config) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/apis/${config.apiId}/operations/${config.operationId}/policies/policy?api-version=${apiVersion}`;

  const policyXml = `
<policies>
  <inbound>
    <base />
    <rewrite-uri template="${config.rewriteUri}" />
  </inbound>
  <backend>
    <base />
  </backend>
  <outbound>
    <base />
  </outbound>
</policies>`;

  await axios.put(url, {
    properties: {
      format: "rawxml",
      value: policyXml
    }
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  console.log(`✅ Rewrite policy applied to operation '${config.operationId}'.`);
}

(async () => {
  try {
    const token = AZURE_ACCESS_TOKEN;
    if (!token) throw new Error("AZURE_ACCESS_TOKEN is missing in environment variables.");

    const configs = await parseCSV(csvFilePath);

    for (const config of configs) {
      await createApi(token, config);
      await assignApiToGateway(token, config);          // ✅ Assign only to self-hosted gateway
      await removeFromManagedGateway(token, config);    // 🚫 Remove from default gateway
      await createOperation(token, config);
      await applyRewritePolicy(token, config);
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
})();
