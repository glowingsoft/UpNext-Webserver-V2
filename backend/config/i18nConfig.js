const i18n = require('i18n');
const path = require('path');

i18n.configure({
  locales: ['en'], // Supported languages e.g ['en', 'es', 'fr']
  directory: path.join(__dirname, '../assets/locales'), // Path to language files
  defaultLocale: 'en', // Default language
  queryParameter: 'lang', // Optional: If you want to support language query parameter (?lang=es)
  cookie: 'lang', // Optional: If you want to support language via cookies
  objectNotation: true, // Allows nested key access like 'error.invalid'
  updateFiles: false, // Prevent automatic creation of missing keys in language files
  autoReload: true, // Automatically reloads locale files when changed (optional)
  syncFiles: true, // Sync across all locales when new keys are added (optional)
});

module.exports = { i18nConfig: i18n };
