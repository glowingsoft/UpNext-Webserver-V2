const fs = require("fs");
const path = require("path");

const controllersDir = path.join(__dirname, "../controllers"); // Path to your controllers folder
const enJsonPath = path.join(__dirname, "../assets/locales/en.json"); // Path to your en.json file

// Function to get all translation keys used in controllers
const getTranslationKeysFromControllers = () => {
  const translationKeys = new Set();
  
  // Read all files in the controllers directory
  const files = fs.readdirSync(controllersDir);
  
  files.forEach((file) => {
    const filePath = path.join(controllersDir, file);
    
    // Only consider JavaScript files
    if (filePath.endsWith(".js")) {
      const content = fs.readFileSync(filePath, "utf-8");

      // Find all instances of translationKey usage
      const regex = /translationKey:\s*"(.*?)"/g;
      let match;

      while ((match = regex.exec(content)) !== null) {
        translationKeys.add(match[1]);
      }
    }
  });

  return translationKeys;
};

// Function to update the en.json file by removing unused keys
const updateEnJsonFile = (usedKeys) => {
  // Read the en.json file
  const enJson = JSON.parse(fs.readFileSync(enJsonPath, "utf-8"));

  // Filter out the unused translation keys
  Object.keys(enJson).forEach((key) => {
    if (!usedKeys.has(key)) {
      delete enJson[key]; // Remove unused key
    }
  });

  // Write the updated content back to en.json
  fs.writeFileSync(enJsonPath, JSON.stringify(enJson, null, 2), "utf-8");

  console.log("en.json updated with only the used translation keys.");
};

// Main function to perform the task
const cleanUpTranslationKeys = () => {
  console.log("Fetching translation keys used in controllers...");

  // Get all translation keys used in the controllers
  const usedTranslationKeys = getTranslationKeysFromControllers();

  console.log("Found the following used translation keys:");
  console.log(usedTranslationKeys);

  // Update the en.json file by removing unused keys
  updateEnJsonFile(usedTranslationKeys);
};

// Run the cleanup process
cleanUpTranslationKeys();
