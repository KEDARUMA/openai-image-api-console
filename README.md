# OpenAI Image API Console

English | [日本語](README.ja.md)

OpenAI Image API Console is an unofficial desktop app for using OpenAI image generation and image editing APIs.

It gives you a local GUI for text-to-image generation, image-to-image generation, mask editing, transparent PNG output, model options, and generation history. It is built with Tauri, React, and Vite, and is available for macOS, Windows, and Linux.

## Download

[Download the latest release](https://github.com/KEDARUMA/openai-image-api-console/releases)

Choose the file that matches your OS:

- macOS Apple Silicon: `*_aarch64.dmg`
- macOS Intel: `*_x64.dmg`
- Windows: `*_x64-setup.exe`
- Ubuntu / Debian: `*_amd64.deb`
- Fedora / RHEL: `*.x86_64.rpm`
- Other Linux: `*_amd64.AppImage`
- `*.app.tar.gz` is usually not needed.

## Quick Start

1. Download the release asset for your OS.
2. Launch the app.
3. Open settings and enter your OpenAI API key.
4. Choose a mode, model, size, quality, background, and output format.
5. Enter a prompt or select input images, then generate an image.

## What You Can Do

- Create images from text prompts.
- Generate variations from input images.
- Edit images with alpha-channel PNG masks.
- Generate transparent-background PNG images.
- Compare model, size, quality, and output format settings.
- Review previously generated images from local history.

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

## macOS Notice

This app is currently distributed without Apple Developer ID signing or notarization. macOS may show a security warning the first time you open it.

## Screenshots

### Main Screen

![Main screen](docs/images/main-screen.png)

### Settings Screen

![Settings screen](docs/images/settings-screen.png)

### Edit with Mask

![Edit with Mask](docs/images/edit-with-mask.png)

## API Key

This app sends requests to the OpenAI API using your OpenAI API key.

The API key is stored locally in the app settings. Do not include API keys in public repositories or screenshots.

## Model Support Matrix

The model selector shows model support and pricing information for each model.

The table below summarizes model support confirmed in the project checklist. `✅` means supported, and `❌` means not supported.

| Model ID | Family | Text to Image | Image to Image | Edit with Mask | Alpha channel support | Pricing |
|---|---|---|---|---|---|---|
| `gpt-image-2` | GPT Image 2 | ✅ | ✅ | ✅ | ✅ | Image: input $8.00 / cached $2.00 / output $30.00; Text: input $5.00 / cached $1.25 |
| `gpt-image-1.5` | GPT Image 1.5 | ✅ | ✅ | ✅ | ✅ | Image: input $8.00 / cached $2.00 / output $32.00; Text: input $5.00 / cached $1.25 / output $10.00 |
| `gpt-image-1` | GPT Image 1 | ✅ | ✅ | ✅ | ✅ | App display: input $10.00 / output $40.00 |
| `gpt-image-1-mini` | GPT Image 1 mini | ✅ | ✅ | ✅ | ✅ | Image: input $2.50 / cached $0.25 / output $8.00; Text: input $2.00 / cached $0.20 |
| `chatgpt-image-latest` | ChatGPT Image | ✅ | ✅ | ✅ | ✅ | App display: input $8.00 / output $32.00 |
| `gpt-5.5` | GPT-5.5 | ✅ | ✅ | ✅ | ❌ | Standard short context: input $5.00 / cached $0.50 / output $30.00 |
| `gpt-5.4` | GPT-5.4 | ✅ | ✅ | ✅ | ❌ | Standard short context: input $2.50 / cached $0.25 / output $15.00 |
| `gpt-5.2` | GPT-5.2 | ✅ | ✅ | ✅ | ❌ | App display: input $1.75 / output $14.00 |
| `gpt-5.4-mini` | GPT-5.4 mini | ✅ | ✅ | ✅ | ❌ | Standard short context: input $0.75 / cached $0.075 / output $4.50 |
| `gpt-5.4-nano` | GPT-5.4 nano | ✅ | ✅ | ✅ | ❌ | Standard short context: input $0.20 / cached $0.02 / output $1.25 |
| `gpt-5-nano` | GPT-5 nano | ✅ | ✅ | ✅ | ❌ | App display: input $0.05 / output $0.40 |

The image generation models clearly confirmed in the official pricing information include `gpt-image-2`, `gpt-image-1.5`, and `gpt-image-1-mini`. `App display` prices are display values from the app configuration.

The displayed prices are hints from the app configuration. Check the official OpenAI pricing information and Billing page for the actual prices, available models, and billing conditions.

## Transparent PNG and Masks

When PNG is selected as the output format and `transparent` is selected as the background, the app can be used for transparent-background image generation.

For mask editing, the app handles alpha-channel PNG masks sent to the API. Transparent areas are intended as editable regions, and opaque areas are intended as protected regions.

## Notes

- This is not an official OpenAI app.
- Using the API requires an OpenAI API key and valid billing setup.
- Generated results and API costs may vary depending on the selected model, quality, size, input, and OpenAI-side changes.
- Do not include files containing secrets in a public repository.

## Development

### Requirements

- Node.js
- npm
- Rust / Cargo
- OS-specific dependencies required by Tauri builds

Check the official Tauri documentation for OS-specific build requirements.

### Setup

Install dependencies.

```bash
npm install
```

### Run locally

```bash
npm run tauri:dev
```

To run only the frontend development server:

```bash
npm run dev
```

### Build

Build the distributable desktop app.

```bash
npm run tauri:build
```

Tauri runs `npm run build` before packaging and bundles the generated `dist/` directory into the app.

## License

MIT License
