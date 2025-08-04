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

function extractProductFromScope(scope) {
  // APIM usually returns scope like '/subscriptions/.../products/{productId}'
  if (!scope || typeof scope !== 'string') return null;
  const match = scope.match(/\/products\/([^/]+)/);
  return match ? match[1] : null;
}

async function getAllSubscriptions() {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}` +
    `/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/subscriptions?api-version=${apiVersion}`;
  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${AZURE_ACCESS_TOKEN}` }
    });
    return response.data.value || [];
  } catch (err) {
    console.error('❌ Failed to fetch subscriptions list.');
    throw err;
  }
}

async function updateSubscription(subscriptionId, newKey, newDisplayName) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}` +
    `/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}` +
    `/subscriptions/${subscriptionId}?api-version=${apiVersion}`;
  const body = {
    properties: {
      primaryKey: newKey,
      displayName: newDisplayName
    }
  };

  try {
    await axios.patch(url, body, {
      headers: {
        Authorization: `Bearer ${AZURE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Updated subscription '${subscriptionId}' (display: '${newDisplayName}')`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to update subscription '${subscriptionId}'`);
    console.error(err.response?.data || err.message);
    return false;
  }
}

async function main() {
  const workbook = XLSX.readFile(filePath);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
  if (!rows.length) {
    console.error(`Excel file '${filePath}' seems empty.`);
    return;
  }

  let updated = 0, failed = 0, notFound = 0;
  const existingSubscriptions = await getAllSubscriptions();

  for (const row of rows) {
    const productName = row.packageName?.trim();
    const apiKey = row.apikey?.trim();

    if (!productName || !apiKey) {
      console.warn(`⚠️ Skipping row due to missing packageName or apikey`);
      failed++;
      continue;
    }

    // Match by scope extract or displayName (covers most APIM setups)
    const matchingSub = existingSubscriptions.find(sub => {
      // 1. Match the productId from scope (recommended)
      const productId = extractProductFromScope(sub.properties?.scope);
      if (productId && productId.toLowerCase() === productName.toLowerCase()) return true;
      // 2. Optionally, also match on subscription displayName (if your naming matches)
      if (sub.properties?.displayName?.trim().toLowerCase() === productName.toLowerCase()) return true;
      return false;
    });

    if (!matchingSub) {
      console.warn(`⚠️ No subscription found matching '${productName}'`);
      notFound++;
      continue;
    }

    const subscriptionId = matchingSub.name;
    const result = await updateSubscription(subscriptionId, apiKey, productName);
    if (result) updated++;
    else failed++;
  }

  console.log(`---\nSummary:`);
  console.log(`Updated: ${updated}`);
  console.log(`Not found: ${notFound}`);
  console.log(`Failed updates: ${failed}`);
}

main()
  .catch(e => {
    console.error("Script failed:");
    console.error(e);
  });
