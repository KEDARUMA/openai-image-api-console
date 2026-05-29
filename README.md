# OpenAI Image API Console

English | [日本語](README.ja.md)

OpenAI Image API Console is an unofficial desktop tool for using OpenAI image generation and image editing APIs.

It is built with Tauri, React, and Vite, and can be built as a desktop app for macOS, Windows, and Linux.

## Download

[Download the latest release](https://github.com/KEDARUMA/openai-image-api-console/releases)

## Features

- Generate images from text prompts
- Generate images with input images
- Edit images with mask images
- Choose PNG, WebP, or JPEG output
- Use transparent PNG output and alpha-channel PNG masks
- Show approximate model pricing in the model selector
- Save generation history locally
- Switch between Japanese and English UI text
- Open the OpenAI API Keys and Billing pages from the settings screen

## Screenshots

### Main Screen

![Main screen](docs/images/main-screen.png)

### Settings Screen

![Settings screen](docs/images/settings-screen.png)

### Edit with Mask

![Edit with Mask](docs/images/edit-with-mask.png)

## Requirements

- Node.js
- npm
- Rust / Cargo
- OS-specific dependencies required by Tauri builds

Check the official Tauri documentation for OS-specific build requirements.

## Setup

Install dependencies.

```bash
npm install
```

## Development

```bash
npm run tauri:dev
```

To run only the frontend development server:

```bash
npm run dev
```

## Build

Build the distributable desktop app.

```bash
npm run tauri:build
```

Tauri runs `npm run build` before packaging and bundles the generated `dist/` directory into the app.

## Usage

1. Launch the app.
2. Open settings and enter your OpenAI API key.
3. Open the API Keys or Billing page if you need to create a key or check billing status.
4. Choose the mode, model, size, quality, background, output format, and other options.
5. Enter a prompt or select input images, then generate an image.
6. Generated images are saved locally and can be reviewed from the history.

## API Key

This app sends requests to the OpenAI API using your OpenAI API key.

The API key is stored locally in the app settings. Do not include API keys in public repositories or screenshots.

## Pricing Hints

The model selector shows approximate pricing for each model.

The displayed prices are hints from the app configuration. Check the official OpenAI pricing information and Billing page for the actual prices, available models, and billing conditions.

## Transparent PNG and Masks

When PNG is selected as the output format and `transparent` is selected as the background, the app can be used for transparent-background image generation.

For mask editing, the app handles alpha-channel PNG masks sent to the API. Transparent areas are intended as editable regions, and opaque areas are intended as protected regions.

## Notes

- This is not an official OpenAI app.
- Using the API requires an OpenAI API key and valid billing setup.
- Generated results and API costs may vary depending on the selected model, quality, size, input, and OpenAI-side changes.
- Do not include files containing secrets in a public repository.

## License

MIT License
