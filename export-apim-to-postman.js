const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const subscriptionId = process.env.SUBSCRIPTION_ID;
const resourceGroup = process.env.RESOURCE_GROUP;
const serviceName = process.env.APIM_NAME;
const accessToken = process.env.AZURE_ACCESS_TOKEN;

const apiVersion = '2022-08-01';

const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
};

async function getApis() {
    const url = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ApiManagement/service/${serviceName}/apis?api-version=${apiVersion}`;
    const response = await axios.get(url, { headers });
    return response.data.value || [];
}

async function getApiOperations(apiName) {
    const url = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ApiManagement/service/${serviceName}/apis/${apiName}/operations?api-version=${apiVersion}`;
    const response = await axios.get(url, { headers });
    return response.data.value || [];
}

function buildItemFromOperation(operation) {
    return {
        name: operation.name,
        request: {
            method: operation.properties.method,
            header: [],
            url: {
                raw: `{{baseUrl}}${operation.properties.urlTemplate}`,
                host: ['{{baseUrl}}'],
                path: operation.properties.urlTemplate.replace(/^\//, '').split('/'),
            },
        },
    };
}

async function exportToSinglePostmanCollection() {
    const apis = await getApis();
    const collection = {
        info: {
            name: `Azure APIM Export`,
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: [],
    };

    for (const api of apis) {
        const apiName = api.properties.displayName;
        const operations = await getApiOperations(api.name);

        const folder = {
            name: apiName,
            item: operations.map(buildItemFromOperation),
        };

        collection.item.push(folder);
        console.log(`✅ Added API: ${apiName} (${operations.length} operations)`);
    }

    fs.writeFileSync('postman-azure-apim-collection.json', JSON.stringify(collection, null, 2));
    console.log('🎉 All APIs exported to postman-azure-apim-collection.json');
}

exportToSinglePostmanCollection().catch(err => {
    console.error('❌ Error exporting APIs:', err.message);
});
