const fs = require('fs');
const XLSX = require('xlsx');

// Step 1: Load your input JSON file
const input = JSON.parse(fs.readFileSync('api_key.json', 'utf8'));

// Step 2: Extract apikey and package name
const simplifiedData = input.map(item => ({
  apikey: item.apikey || '',
  packageName: item.package?.name || ''
}));

// Step 3: Create a new workbook and worksheet
const worksheet = XLSX.utils.json_to_sheet(simplifiedData);
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, worksheet, 'API Keys');

// Step 4: Write to Excel file
XLSX.writeFile(workbook, 'apikeys_output.xlsx');

console.log('✅ Excel file created: apikeys_output.xlsx');
