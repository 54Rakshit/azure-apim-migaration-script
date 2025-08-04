require('dotenv').config();
const axios = require('axios');

const {
  AZURE_ACCESS_TOKEN,
  SUBSCRIPTION_ID,
  RESOURCE_GROUP,
  APIM_NAME
} = process.env;

const apiVersion = '2022-08-01';

async function getAllProducts() {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/products?api-version=${apiVersion}`;
  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${AZURE_ACCESS_TOKEN}` }
    });
    return response.data.value || [];
  } catch (err) {
    console.error('❌ Failed to fetch product list');
    console.error(err.response?.data || err.message);
    return [];
  }
}

async function deleteProduct(productId) {
  const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_NAME}/products/${productId}?api-version=${apiVersion}`;
  try {
    await axios.delete(url, {
      headers: { Authorization: `Bearer ${AZURE_ACCESS_TOKEN}` }
    });
    console.log(`🗑️ Deleted product: ${productId}`);
  } catch (err) {
    console.error(`❌ Failed to delete product '${productId}'`);
    console.error(err.response?.data || err.message);
  }
}

async function deleteAllProducts() {
  const products = await getAllProducts();
  if (products.length === 0) {
    console.log('ℹ️ No products found to delete.');
    return;
  }

  for (const product of products) {
    await deleteProduct(product.name);
  }
}

deleteAllProducts();
