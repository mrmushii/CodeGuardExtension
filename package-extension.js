#!/usr/bin/env node

/**
 * Extension Packaging Script
 * Creates a ZIP file of the extension for distribution
 * 
 * Usage:
 *   node package-extension.js
 *   node package-extension.js --version 1.1
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const EXTENSION_DIR = __dirname;
const OUTPUT_DIR = path.join(EXTENSION_DIR, '..', 'dist');
const VERSION = process.argv.includes('--version') 
  ? process.argv[process.argv.indexOf('--version') + 1] 
  : require('./manifest.json').version;

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Files to include in the package
const FILES_TO_INCLUDE = [
  'manifest.json',
  'background.js',
  'config.js',
  'content.js',
  'html2canvas.min.js',
  'recording.js',
  'README.md',
];

// Create temp directory for packaging
const TEMP_DIR = path.join(EXTENSION_DIR, 'temp-package');
if (fs.existsSync(TEMP_DIR)) {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEMP_DIR, { recursive: true });

console.log('📦 Packaging CodeGuard Extension...');
console.log(`   Version: ${VERSION}`);
console.log(`   Output: ${OUTPUT_DIR}`);

// Copy files to temp directory
console.log('\n📋 Copying files...');
FILES_TO_INCLUDE.forEach(file => {
  const sourcePath = path.join(EXTENSION_DIR, file);
  const destPath = path.join(TEMP_DIR, file);
  
  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, destPath);
    console.log(`   ✓ ${file}`);
  } else {
    console.warn(`   ⚠ ${file} not found, skipping...`);
  }
});

// Update manifest version if provided
if (process.argv.includes('--version')) {
  const manifestPath = path.join(TEMP_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = VERSION;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`   ✓ Updated manifest.json version to ${VERSION}`);
}

// Create ZIP file
const zipFileName = `codeguard-extension-v${VERSION}.zip`;
const zipFilePath = path.join(OUTPUT_DIR, zipFileName);

console.log('\n🗜️  Creating ZIP file...');

try {
  // Use native zip command (works on macOS, Linux, and Windows with Git Bash)
  // Fix: Use single quotes for PowerShell paths to handle spaces correctly, or ensure proper escaping
  const zipCommand = process.platform === 'win32'
    ? `powershell -Command "Compress-Archive -Path '${TEMP_DIR}\\*' -DestinationPath '${zipFilePath}' -Force"`
    : `cd "${TEMP_DIR}" && zip -r "${zipFilePath}" . -q`;

// ... (previous code)

  execSync(zipCommand, { stdio: 'inherit' });
  
  // Verify ZIP was created
  if (fs.existsSync(zipFilePath)) {
    const stats = fs.statSync(zipFilePath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`\n✅ Extension packaged successfully!`);
    console.log(`   File: ${zipFilePath}`);
    console.log(`   Size: ${fileSizeMB} MB`);

    // --- DEPLOY TO SERVER ---
    console.log('\n🚀 Deploying to server...');
    const SERVER_PUBLIC_DIR = path.join(EXTENSION_DIR, '..', 'CodeGuard-Server-Side-', 'public', 'extension');
    
    // Ensure server public dir exists
    if (!fs.existsSync(SERVER_PUBLIC_DIR)) {
      fs.mkdirSync(SERVER_PUBLIC_DIR, { recursive: true });
    }

    // 1. Copy ZIP to server
    const serverZipPath = path.join(SERVER_PUBLIC_DIR, 'codeguard-extension.zip');
    fs.copyFileSync(zipFilePath, serverZipPath);
    console.log(`   ✓ Copied zip to ${serverZipPath}`);

    // 2. Create version.json
    const versionData = { version: VERSION };
    fs.writeFileSync(path.join(SERVER_PUBLIC_DIR, 'version.json'), JSON.stringify(versionData, null, 2));
    console.log(`   ✓ Updated version.json to ${VERSION}`);

    console.log(`\n📤 Ready for upload!`);
    console.log(`   The extension has been copied to the server's public folder.`);
    console.log(`   Just push the server code to deploy.`);
  } else {
    throw new Error('ZIP file was not created');
  }
} catch (error) {
  console.error('\n❌ Error creating ZIP file:', error.message);
  console.error('\n💡 Alternative: Manually zip the temp-package folder');
  console.error(`   Location: ${TEMP_DIR}`);
  process.exit(1);
}

// Cleanup temp directory
console.log('\n🧹 Cleaning up...');
fs.rmSync(TEMP_DIR, { recursive: true, force: true });
console.log('✅ Done!');

