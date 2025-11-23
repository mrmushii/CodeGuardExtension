# CodeGuard Extension - Installation Guide

## Overview
The CodeGuard Proctor extension is required for students to take exams. It monitors browsing activity to ensure exam integrity.

## Quick Setup

### 1. Package the Extension

Run the packaging script to create a distributable ZIP file:

```bash
cd Chrome-manifest_extension
node package-extension.js
```

Or with a specific version:

```bash
node package-extension.js --version 1.2
```

This will create a ZIP file in the `dist/` directory.

### 2. Host the Extension

#### Option A: GitHub Releases (Recommended)

1. Create a new release on GitHub
2. Upload the ZIP file as a release asset
3. Update the download URLs in `ExtensionPrompt.jsx`:

```javascript
const EXTENSION_DOWNLOAD_URLS = {
  chrome: 'https://github.com/yourusername/CodeGuard-Extension/releases/latest/download/codeguard-extension-v1.1.zip',
  edge: 'https://github.com/yourusername/CodeGuard-Extension/releases/latest/download/codeguard-extension-v1.1.zip',
  // ...
};
```

#### Option B: Your Server

1. Upload the ZIP file to your server (e.g., `/public/extensions/`)
2. Update the download URLs in `ExtensionPrompt.jsx`:

```javascript
const EXTENSION_DOWNLOAD_URLS = {
  chrome: 'https://your-domain.com/extensions/codeguard-extension-v1.1.zip',
  edge: 'https://your-domain.com/extensions/codeguard-extension-v1.1.zip',
  // ...
};
```

### 3. Installation Instructions for Users

The extension must be installed in **Developer Mode**:

#### Chrome
1. Download the extension ZIP file
2. Extract it to a folder
3. Go to `chrome://extensions/`
4. Enable "Developer mode" (toggle in top right)
5. Click "Load unpacked"
6. Select the extracted folder

#### Edge
1. Download the extension ZIP file
2. Extract it to a folder
3. Go to `edge://extensions/`
4. Enable "Developer mode" (toggle in bottom left)
5. Click "Load unpacked"
6. Select the extracted folder

#### Opera
1. Download the extension ZIP file
2. Extract it to a folder
3. Go to `opera://extensions/`
4. Enable "Developer mode" (toggle in top right)
5. Click "Load unpacked"
6. Select the extracted folder

## Features

- **Automatic Detection**: The web app automatically detects if the extension is installed
- **Browser Detection**: Automatically detects the user's browser
- **One-Click Download**: Users can download the extension with a single click
- **Installation Guide**: Step-by-step instructions are shown in the UI
- **Auto-Refresh**: The app periodically checks if the extension is installed

## Development

### File Structure
```
Chrome-manifest_extension/
├── manifest.json          # Extension manifest
├── background.js          # Background service worker
├── content.js            # Content script
├── html2canvas.min.js    # Screenshot library
├── package-extension.js  # Packaging script
└── README.md             # This file
```

### Testing

1. Load the extension in developer mode
2. Navigate to the student dashboard
3. The extension prompt should appear if extension is not detected
4. After installation, refresh the page - extension should be detected

## Troubleshooting

### Extension Not Detected

1. Make sure the extension is enabled in browser extensions page
2. Check that you're not in incognito mode (extensions may be disabled)
3. Refresh the page after installing
4. Check browser console for errors

### Download Issues

1. Verify the download URL is correct
2. Check that the ZIP file is accessible
3. Ensure CORS is properly configured if hosting on a different domain

### Installation Issues

1. Make sure Developer Mode is enabled
2. Verify the extracted folder contains all required files
3. Check browser console for extension errors

## Version History

- **v1.1**: Initial release with monitoring and whitelist features
- **v1.0**: Basic monitoring functionality

## Support

For issues or questions, please contact the development team or open an issue on GitHub.

