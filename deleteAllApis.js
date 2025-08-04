const axios = require('axios');
require('dotenv').config(); // optional, for .env file usage

const subscriptionId = process.env.SUBSCRIPTION_ID;
const resourceGroup = process.env.RESOURCE_GROUP;
const serviceName = process.env.APIM_NAME;
const accessToken = process.env.AZURE_ACCESS_TOKEN;
const apiVersion = '2022-08-01';

const headers = {
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json'
};

async function getAllApis() {
  const url = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ApiManagement/service/${serviceName}/apis?api-version=${apiVersion}`;
  try {
    const response = await axios.get(url, { headers });
    return response.data.value || [];
  } catch (error) {
    console.error('Error fetching APIs:', error.response?.data || error.message);
    process.exit(1);
  }
}

async function deleteApi(apiName) {
  const url = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ApiManagement/service/${serviceName}/apis/${apiName}?api-version=${apiVersion}`;
  try {
    await axios.delete(url, { headers });
    console.log(`✅ Deleted API: ${apiName}`);
  } catch (error) {
    console.error(`❌ Failed to delete API ${apiName}:`, error.response?.data || error.message);
  }
}

async function deleteAllApis() {
  const apis = await getAllApis();
  if (apis.length === 0) {
    console.log('No APIs found in the APIM instance.');
    return;
  }

  console.log(`Found ${apis.length} APIs. Starting deletion...`);
  for (const api of apis) {
    const apiName = api.name;
    await deleteApi(apiName);
  }
}

deleteAllApis();
