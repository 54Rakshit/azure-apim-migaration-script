require('dotenv').config();
const axios = require('axios');
const XLSX = require('xlsx');

const {
  AZURE_ACCESS_TOKEN,
  SUBSCRIPTION_ID,
  RESOURCE_GROUP,
  APIM_NAME
} = process.env;

const apiVersion = '2022-08-01';
const filePath = './apikeys_output.xlsx';

function sanitizeId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/gi, '-');
}

async function getProduct(productId) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/products/${productId}?api-version=${apiVersion}`;
  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${AZURE_ACCESS_TOKEN}` }
    });
    return response.data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    console.error(`❌ Error checking product ${productId}:`, err.message);
    return null;
  }
}

async function createOrUpdateProduct(productId, displayName, existingProduct) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/products/${productId}?api-version=${apiVersion}`;
  const body = {
    properties: {
      displayName,
      description: `Product for ${displayName}`,
      subscriptionRequired: true,
      approvalRequired: false,
      state: "published"
    }
  };

  try {
    await axios.put(url, body, {
      headers: {
        Authorization: `Bearer ${AZURE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (existingProduct) {
      console.log(`🛠️ Updated product '${productId}' with displayName: '${displayName}'`);
    } else {
      console.log(`✅ Created product: '${displayName}'`);
    }
  } catch (err) {
    console.error(`❌ Failed to create/update product '${displayName}':`, err.response?.data || err.message);
  }
}

async function updateSubscriptionDisplayName(apiKey, displayName) {
  try {
    const listUrl = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/subscriptions?api-version=${apiVersion}`;
    const subsResponse = await axios.get(listUrl, {
      headers: { Authorization: `Bearer ${AZURE_ACCESS_TOKEN}` }
    });

    const match = subsResponse.data.value.find(sub =>
      sub.properties.primaryKey === apiKey || sub.properties.secondaryKey === apiKey
    );

    if (!match) {
      console.warn(`⚠️ No matching subscription found for apikey: ${apiKey}`);
      return;
    }

    const subId = match.name;
    const updateUrl = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/subscriptions/${subId}?api-version=${apiVersion}`;

    const updated = {
      properties: {
        displayName, // ✅ Set display name here
        scope: match.properties.scope,
        ownerId: match.properties.ownerId,
        state: match.properties.state,
        primaryKey: match.properties.primaryKey,
        secondaryKey: match.properties.secondaryKey
      }
    };

    await axios.put(updateUrl, updated, {
      headers: {
        Authorization: `Bearer ${AZURE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`🔑 Updated subscription '${subId}' displayName to '${displayName}'`);
  } catch (err) {
    console.error(`❌ Failed to update subscription for apikey '${apiKey}':`, err.response?.data || err.message);
  }
}

async function processExcel() {
  const workbook = XLSX.readFile(filePath);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

  for (const row of rows) {
    const packageName = row.packageName?.trim();
    const apiKey = row.apikey?.trim();

    if (!packageName || !apiKey) {
      console.warn(`⚠️ Skipping row due to missing values`);
      continue;
    }

    const productId = sanitizeId(packageName);
    const existingProduct = await getProduct(productId);

    await createOrUpdateProduct(productId, packageName, existingProduct);
    await updateSubscriptionDisplayName(apiKey, packageName);
  }
}

processExcel();
