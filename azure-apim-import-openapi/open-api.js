const fs = require('fs');
const xlsx = require('xlsx');
const path = require('path');

// Load the Excel file
const inputFilePath = 'ReportPopulusReport20250312_141335.xlsx'; // Path to your Excel file
const workbook = xlsx.readFile(inputFilePath);
const sheetName = workbook.SheetNames[0]; // Assuming data is in the first sheet
const sheet = workbook.Sheets[sheetName];

// Convert the sheet data to JSON
const data = xlsx.utils.sheet_to_json(sheet);

// Function to generate OpenAPI 3.0 specification in JSON format for each row
function generateOpenAPIForRow(row) {
  const openAPI = {
    openapi: '3.0.0',
    info: {
      title: 'API Definition',
      version: '1.0.0',
    },
    servers: [],
    paths: {},
    components: {
      securitySchemes: {},
    },
    security: [],
  };

  const method = row.SupportedHttpMethods.split(',').map((m) => m.trim());
  const path = row.OutboundRequestTargetPath;
  const domain = row.publicDomainsAddress;
  const apiKeyLocation = row.apiKeyValueLocations;
  
  // Check if requestAuthenticationType exists and is an 'api key'
  const apiKeyUsed = row.requestAuthenticationType && row.requestAuthenticationType.toLowerCase() === 'api key';

  // Add servers section if not already present
  if (!openAPI.servers.some((server) => server.url === domain)) {
    openAPI.servers.push({ url: domain });
  }

  // Define path and methods
  if (!openAPI.paths[path]) {
    openAPI.paths[path] = {};
  }

  method.forEach((m) => {
    openAPI.paths[path][m.toLowerCase()] = {
      summary: row.Name,
      operationId: `${row.Name}_${m}`,
      responses: {
        '200': {
          description: 'Successful response',
        },
      },
    };
  });

  // Add security scheme if API key is used
  if (apiKeyUsed && !openAPI.components.securitySchemes.apiKey) {
    openAPI.components.securitySchemes.apiKey = {
      type: 'apiKey',
      in: apiKeyLocation,
      name: 'apiKey',
    };
    openAPI.security.push({ apiKey: [] });
  }

  return openAPI;
}

// Loop through each row and generate a separate OpenAPI spec file
data.forEach((row) => {
  const openAPIJson = generateOpenAPIForRow(row);

  // Define the output file name based on the 'Name' field
  const fileName = row.Name.replace(/\s+/g, '_'); // Replace spaces with underscores to make a valid filename
  const outputFilePath = `${fileName}_openapi_spec.json`;

  // Write the OpenAPI spec to a file
  fs.writeFileSync(outputFilePath, JSON.stringify(openAPIJson, null, 2));

  console.log(`OpenAPI specification for '${row.Name}' has been saved as ${outputFilePath}`);
});
