import {
  DragEvent,
  PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import appIcon from "./assets/app-icon.png";
import {
  Brush,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Eraser,
  FileText,
  History,
  Image as ImageIcon,
  Play,
  Save,
  Settings,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from "lucide-react";

type AppSettings = {
  apiKey: string;
  language: string;
};

type WorkMode = "text" | "image" | "edit-mask";

type GenerateForm = {
  mode: WorkMode;
  model: string;
  prompt: string;
  filename: string;
  size: string;
  quality: string;
  outputFormat: string;
  outputCompression: number;
  background: string;
  moderation: string;
  action: string;
  count: number;
  inputImages: ImageAsset[];
  maskImage: ImageAsset | null;
};

type ImageAsset = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  path?: string;
  maskEncoding?: "api-alpha" | "ui-red";
  width?: number;
  height?: number;
};

type GeneratedImage = {
  path: string;
  dataUrl: string;
};

type GenerateResponse = {
  images: GeneratedImage[];
  logs: string[];
};

type SelectOption = {
  value: string;
  label: string;
};

type HistoryItem = {
  id: string;
  createdAt: string;
  prompt: string;
  settings: GenerateForm;
  images: GeneratedImage[];
};

type AppConfig = {
  defaults: Omit<GenerateForm, "inputImages" | "maskImage">;
  limits: {
    history: number;
    countMin: number;
    countMax: number;
    outputCompressionMin: number;
    outputCompressionMax: number;
    requestDelayMs: number;
  };
  modes: WorkMode[];
  models: SelectOption[];
  imageEditModels: SelectOption[];
  sizes: string[];
  qualities: string[];
  outputFormats: string[];
  backgrounds: string[];
  moderations: string[];
};

type LocaleText = Record<string, string>;

type LocaleInfo = {
  code: string;
  name: string;
};

type RuntimeConfigBundle = {
  config: AppConfig;
  locale: LocaleText;
  availableLocales: LocaleInfo[];
  configDir: string;
  outputDir: string;
};

type GenerationProgress = {
  current: number;
  total: number;
};

const historyKey = "openai-image-api.history.v1";
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const backendTimeoutMs = 180_000;
const backendWaitLogMs = [60_000, 120_000];
const fallbackLocale: LocaleText = {
  "meta.name": "English",
  "app.title": "OpenAI Image API Console",
  "app.subtitle": "Responses API image_generation desktop console",
  "button.settings": "Settings",
  "section.composer": "Generation Settings",
  "section.preview": "Preview",
  "section.history": "History",
  "section.debug": "Debug Log",
  "tab.text": "Text to Image",
  "tab.image": "Image to Image",
  "tab.edit-mask": "Edit with Mask",
  "field.prompt": "Prompt",
  "field.prompt.placeholder":
    "Describe the image you want to generate or edit.",
  "field.uploadImages":
    "Drop images here, click to choose files, or paste from clipboard.",
  "field.model": "Model",
  "field.size": "Size",
  "field.quality": "Quality",
  "field.format": "Format",
  "field.background": "Background",
  "field.moderation": "Moderation",
  "field.compression": "Compression {value}%",
  "field.compression.disabled": "Compression disabled for PNG",
  "field.count": "Count {value}",
  "field.language": "Language",
  "field.apiKey": "OpenAI API Key",
  "field.apiKey.placeholder": "Paste your API key here.",
  "action.generate": "Generate",
  "action.generating": "Generate",
  "action.generatingProgress": "Generate [{current}/{total}]",
  "action.stop": "Stop",
  "action.finder": "Show in Folder",
  "action.saveAs": "Save As",
  "action.copy": "Copy",
  "action.copyError": "Copy Error",
  "action.copyLogs": "Copy logs",
  "action.clearLogs": "Clear logs",
  "action.openLogs": "Open logs",
  "action.closeLogs": "Close logs",
  "action.openBilling": "Billing",
  "action.openApiKeys": "API Keys",
  "action.close": "Close",
  "action.save": "Save",
  "action.createBlankCanvas": "Blank Image",
  "action.loadMask": "Load Mask",
  "action.clear": "Clear",
  "empty.preview": "Generated images will appear here.",
  "empty.history": "No history yet.",
  "empty.logs": "No logs yet.",
  "status.tauriOnly":
    "API key storage and image generation are available inside the Tauri app.",
  "status.settingsSaved": "Settings saved.",
  "status.generating": "Generating...",
  "status.cancelled":
    "Generation stopped. Backend response will be ignored if it arrives later.",
  "status.savedImages": "Saved {count} image(s) to {path}.",
  "status.pastedImages": "Pasted {count} image(s) from clipboard.",
  "status.copiedImage": "Copied image data to clipboard.",
  "status.copiedError": "Copied error details to clipboard.",
  "status.savedAs": "Saved As: {path}",
  "status.loadedHistory": "Loaded settings and images from history.",
  "status.waitingBackend":
    "Still waiting for backend response after {seconds}s. Do not click Generate again.",
  "error.backendTimeout": "Backend response timeout after {seconds}s.",
  "message.needInputImage": "Add an input image.",
  "message.needMaskImage": "Load a mask image or draw one with the brush.",
  "message.addInputFirst": "Add an input image first.",
  "message.maskSizeMismatch":
    "Mask size must match input image size. Input: {inputWidth}x{inputHeight}, mask: {maskWidth}x{maskHeight}.",
  "modal.error.title": "Image generation failed",
  "modal.settings.title": "Settings",
  "aria.settings": "Settings",
  "aria.composer": "Generation settings",
  "aria.preview": "Preview",
  "aria.history": "History",
  "aria.debug": "Debug log",
  "aria.modeTabs": "Generation mode",
  "aria.error": "Image generation error",
  "title.close": "Close",
  "title.delete": "Delete",
  "title.finder": "Show in Folder",
  "title.saveAs": "Save as",
  "title.copyImage": "Copy image",
  "error.tauriOnly": "Run this inside the Tauri app.",
};

const fallbackAppConfig: AppConfig = {
  defaults: {
    mode: "text",
    model: "gpt-5.4-mini",
    prompt: "",
    filename: "openai-image",
    size: "auto",
    quality: "high",
    outputFormat: "png",
    outputCompression: 90,
    background: "transparent",
    moderation: "auto",
    action: "generate",
    count: 1,
  },
  limits: {
    history: 100,
    countMin: 1,
    countMax: 8,
    outputCompressionMin: 0,
    outputCompressionMax: 100,
    requestDelayMs: 3000,
  },
  modes: ["text", "image", "edit-mask"],
  models: [
    { value: "gpt-image-2", label: "gpt-image-2 ($8.00 / $30.00)" },
    { value: "gpt-image-1.5", label: "gpt-image-1.5 ($8.00 / $32.00)" },
    { value: "gpt-image-1", label: "gpt-image-1 ($10.00 / $40.00)" },
    { value: "gpt-image-1-mini", label: "gpt-image-1-mini ($2.50 / $8.00)" },
    {
      value: "chatgpt-image-latest",
      label: "chatgpt-image-latest ($8.00 / $32.00)",
    },
    { value: "gpt-5.5", label: "gpt-5.5 ($5.00 / $30.00)" },
    { value: "gpt-5.4", label: "gpt-5.4 ($2.50 / $15.00)" },
    { value: "gpt-5.2", label: "gpt-5.2 ($1.75 / $14.00)" },
    { value: "gpt-5.4-mini", label: "gpt-5.4-mini ($0.75 / $4.50)" },
    { value: "gpt-5.4-nano", label: "gpt-5.4-nano ($0.20 / $1.25)" },
    { value: "gpt-5-nano", label: "gpt-5-nano ($0.05 / $0.40)" },
  ],
  imageEditModels: [
    { value: "gpt-image-2", label: "gpt-image-2 ($8.00 / $30.00)" },
    { value: "gpt-image-1.5", label: "gpt-image-1.5 ($8.00 / $32.00)" },
    { value: "gpt-image-1", label: "gpt-image-1 ($10.00 / $40.00)" },
    { value: "gpt-image-1-mini", label: "gpt-image-1-mini ($2.50 / $8.00)" },
    {
      value: "chatgpt-image-latest",
      label: "chatgpt-image-latest ($8.00 / $32.00)",
    },
    { value: "gpt-5.5", label: "gpt-5.5 ($5.00 / $30.00)" },
    { value: "gpt-5.4", label: "gpt-5.4 ($2.50 / $15.00)" },
    { value: "gpt-5.2", label: "gpt-5.2 ($1.75 / $14.00)" },
    { value: "gpt-5.4-mini", label: "gpt-5.4-mini ($0.75 / $4.50)" },
    { value: "gpt-5.4-nano", label: "gpt-5.4-nano ($0.20 / $1.25)" },
    { value: "gpt-5-nano", label: "gpt-5-nano ($0.05 / $0.40)" },
  ],
  sizes: ["auto", "1024x1024", "1024x1536", "1536x1024"],
  qualities: ["auto", "low", "medium", "high"],
  outputFormats: ["png", "webp", "jpeg"],
  backgrounds: ["auto", "transparent", "opaque"],
  moderations: ["auto", "low"],
};

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({
    apiKey: "",
    language: "en",
  });
  const [appConfig, setAppConfig] = useState<AppConfig>(fallbackAppConfig);
  const [locale, setLocale] = useState<LocaleText>(fallbackLocale);
  const [availableLocales, setAvailableLocales] = useState<LocaleInfo[]>([
    { code: "en", name: "English" },
  ]);
  const [outputDir, setOutputDir] = useState(
    "/Users/pooh/Pictures/OpenAI Image API Console",
  );
  const [form, setForm] = useState<GenerateForm>(() =>
    buildInitialForm(fallbackAppConfig),
  );
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [brushSize, setBrushSize] = useState(44);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    image: GeneratedImage;
  } | null>(null);
  const [historyReady, setHistoryReady] = useState(false);
  const [errorDialog, setErrorDialog] = useState<string | null>(null);
  const [generationProgress, setGenerationProgress] =
    useState<GenerationProgress | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);
  const generationRunIdRef = useRef(0);
  const cancelledRunIdsRef = useRef<Set<number>>(new Set());
  const backendWaitTimersRef = useRef<number[]>([]);

  const canCompress =
    form.outputFormat === "jpeg" || form.outputFormat === "webp";
  const historyLimit = appConfig.limits.history;
  const tabs = useMemo(
    () =>
      appConfig.modes.map((id) => ({
        id,
        label: translate(locale, `tab.${id}`),
      })),
    [appConfig.modes, locale],
  );
  const selectedHistory = useMemo(
    () => history.find((item) => item.id === selectedHistoryId) ?? null,
    [history, selectedHistoryId],
  );
  const buttonLabel = busy
    ? translate(locale, "action.stop")
    : translate(locale, "action.generate");

  function t(key: string, replacements?: Record<string, string | number>) {
    return translate(locale, key, replacements);
  }

  function applyRuntimeBundle(bundle: RuntimeConfigBundle) {
    const normalizedConfig = normalizeAppConfig(bundle.config);
    setAppConfig(normalizedConfig);
    setLocale({ ...fallbackLocale, ...bundle.locale });
    setAvailableLocales(
      bundle.availableLocales.length > 0
        ? bundle.availableLocales
        : [{ code: "en", name: "English" }],
    );
    setOutputDir(bundle.outputDir);
    setForm((current) =>
      normalizeFormAgainstConfig(
        {
          ...buildInitialForm(normalizedConfig),
          prompt: current.prompt,
          inputImages: current.inputImages,
          maskImage: current.maskImage,
        },
        normalizedConfig,
      ),
    );
  }

  function notifyError(error: unknown) {
    const errorText = formatErrorText(error);
    setMessage(errorText.split("\n")[0] || errorText);
    setErrorDialog(errorText);
    return errorText;
  }

  useEffect(() => {
    let removeDebugLogListener: (() => void) | null = null;
    let removeProgressListener: (() => void) | null = null;
    let removeGeneratedImageListener: (() => void) | null = null;
    let disposed = false;

    if (isTauri) {
      tauriInvoke<AppSettings>("load_settings")
        .then(async (value) => {
          const nextSettings = normalizeSettings(value);
          setSettings(nextSettings);
          const bundle = await tauriInvoke<RuntimeConfigBundle>(
            "load_runtime_config",
            { language: nextSettings.language },
          );
          applyRuntimeBundle(bundle);
          const normalizedConfig = normalizeAppConfig(bundle.config);
          const items = await tauriInvoke<HistoryItem[]>("load_history");
          const normalizedItems = items
            .map((item) => normalizeStoredHistoryItem(item, normalizedConfig))
            .slice(0, normalizedConfig.limits.history);
          setHistory(await loadHistoryImages(normalizedItems));
          window.localStorage.removeItem(historyKey);
        })
        .catch((error) => notifyError(error))
        .finally(() => setHistoryReady(true));
      listen<string>("debug-log", (event) => {
        setDebugLogs((current) => [...current, event.payload]);
      })
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          removeDebugLogListener = unlisten;
        })
        .catch((error) => notifyError(error));
      listen<GenerationProgress>("generation-progress", (event) => {
        setGenerationProgress(event.payload);
      })
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          removeProgressListener = unlisten;
        })
        .catch((error) => notifyError(error));
      listen<GeneratedImage>("generated-image", (event) => {
        if (cancelledRunIdsRef.current.size > 0) {
          setDebugLogs((current) => [
            ...current,
            `frontend: generated-image event received after stop; ignored path=${event.payload.path}`,
          ]);
          return;
        }
        setImages((current) => appendUniqueImage(current, event.payload));
      })
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          removeGeneratedImageListener = unlisten;
        })
        .catch((error) => notifyError(error));
    } else {
      setMessage(translate(fallbackLocale, "status.tauriOnly"));
      setHistoryReady(true);
    }

    return () => {
      disposed = true;
      removeDebugLogListener?.();
      removeProgressListener?.();
      removeGeneratedImageListener?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri || !historyReady) {
      return;
    }

    tauriInvoke("save_history", {
      history: history.slice(0, historyLimit).map(stripHistoryItemForStorage),
    }).catch((error) => {
      setDebugLogs((current) => [
        ...current,
        `frontend: history persistence skipped=${String(error)}`,
      ]);
    });
  }, [history, historyReady]);

  useEffect(() => {
    composerRef.current?.scrollTo({ top: 0 });
  }, [form.mode]);

  useEffect(() => {
    if (form.mode === "text" || settingsOpen || errorDialog) {
      return;
    }

    function handlePaste(event: ClipboardEvent) {
      const files = imageFilesFromClipboard(event.clipboardData);
      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      void addFiles(files, "input")
        .then(() => {
          setMessage(t("status.pastedImages", { count: files.length }));
        })
        .catch((error) => notifyError(error));
    }

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [form.mode, settingsOpen, errorDialog, locale]);

  function updateForm<K extends keyof GenerateForm>(
    key: K,
    value: GenerateForm[K],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function modelOptions() {
    return modelsForMode(appConfig, form.mode);
  }

  function normalizedForm() {
    const nextForm = normalizeFormAgainstConfig(form, appConfig);

    if (JSON.stringify(nextForm) === JSON.stringify(form)) {
      return form;
    }

    setForm(nextForm);
    return nextForm;
  }

  async function changeLanguage(language: string) {
    const nextSettings = { ...settings, language };
    setSettings(nextSettings);
    if (!isTauri) {
      return;
    }
    try {
      const nextLocale = await tauriInvoke<LocaleText>("load_locale", {
        language,
      });
      setLocale({ ...fallbackLocale, ...nextLocale });
    } catch (error) {
      notifyError(error);
    }
  }

  async function saveSettings() {
    try {
      ensureTauri(t("error.tauriOnly"));
      await tauriInvoke("save_settings", { settings });
      setSettingsOpen(false);
      setMessage(t("status.settingsSaved"));
    } catch (error) {
      notifyError(error);
    }
  }

  async function openExternalUrl(url: string) {
    try {
      await tauriInvoke("open_external_url", { url });
    } catch (error) {
      notifyError(error);
    }
  }

  async function addFiles(
    fileList: FileList | File[],
    target: "input" | "mask",
  ) {
    const files = imageFilesFromList(fileList);
    if (files.length === 0) {
      return;
    }

    const assets = await Promise.all(files.map(readFileAsAsset));

    if (target === "mask") {
      setForm((current) => ({
        ...current,
        maskImage: assets[0] ? { ...assets[0], maskEncoding: "ui-red" } : null,
      }));
      return;
    }

    setForm((current) => ({
      ...current,
      inputImages: [...current.inputImages, ...assets],
    }));
  }

  function createBlankInputImage() {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 1024;
    const context = canvas.getContext("2d");
    if (context) {
      const imageData = context.createImageData(canvas.width, canvas.height);
      for (let index = 0; index < imageData.data.length; index += 4) {
        imageData.data[index] = 255;
        imageData.data[index + 1] = 255;
        imageData.data[index + 2] = 255;
        imageData.data[index + 3] = 0;
      }
      context.putImageData(imageData, 0, 0);
    }

    setForm((current) => {
      if (current.inputImages.length > 0) {
        return current;
      }

      return {
        ...current,
        inputImages: [
          {
            id: crypto.randomUUID(),
            name: "blank-1024x1024.png",
            mimeType: "image/png",
            dataUrl: canvas.toDataURL("image/png"),
            width: 1024,
            height: 1024,
          },
        ],
        maskImage: null,
      };
    });
  }

  function removeInputImage(id: string) {
    updateForm(
      "inputImages",
      form.inputImages.filter((image) => image.id !== id),
    );
  }

  async function generate() {
    if (busy) {
      setDebugLogs((current) => [
        ...current,
        "frontend: ignored duplicate generate click while busy",
      ]);
      return;
    }
    const runId = generationRunIdRef.current + 1;
    generationRunIdRef.current = runId;
    cancelledRunIdsRef.current.delete(runId);
    const baseForm = normalizedForm();
    setBusy(true);
    setGenerationProgress(null);
    setImages([]);
    setMessage(t("status.generating"));
    setSelectedHistoryId(null);
    const startedAt = new Date().toLocaleString();
    const baseLogs = [
      `[${startedAt}] frontend: generate clicked`,
      `frontend: mode=${baseForm.mode} model=${baseForm.model} action=${baseForm.action} size=${baseForm.size} quality=${baseForm.quality} format=${baseForm.outputFormat} count=${baseForm.count}`,
    ];
    setDebugLogs(baseLogs);

    try {
      ensureTauri(t("error.tauriOnly"));
      await validateRequest(baseForm, t);
      const prepared = await prepareRequestForm(baseForm);
      const requestForm = prepared.form;
      await validateRequest(requestForm, t);
      setDebugLogs((current) => [
        ...current,
        ...prepared.logs,
        `frontend: prepared input_images=${requestForm.inputImages.length} mask=${Boolean(requestForm.maskImage)}`,
        `frontend: prepared input_media_types=${requestForm.inputImages.map((image) => image.mimeType).join(", ") || "(none)"}`,
        `frontend: prepared mask_media_type=${requestForm.maskImage?.mimeType || "(none)"}`,
        `frontend: request preview json=${buildFrontendRequestPreview(requestForm)}`,
        "frontend: invoking backend generate_image",
      ]);
      backendWaitTimersRef.current = backendWaitLogMs.map((milliseconds) =>
        window.setTimeout(() => {
          if (cancelledRunIdsRef.current.has(runId)) {
            return;
          }
          setDebugLogs((current) => [
            ...current,
            `frontend: ${t("status.waitingBackend", { seconds: Math.round(milliseconds / 1000) })}`,
          ]);
        }, milliseconds),
      );
      const response = await withTimeout(
        tauriInvoke<GenerateResponse>("generate_image", {
          request: requestForm,
        }),
        backendTimeoutMs,
        t("error.backendTimeout", {
          seconds: Math.round(backendTimeoutMs / 1000),
        }),
      );
      if (
        cancelledRunIdsRef.current.has(runId) ||
        generationRunIdRef.current !== runId
      ) {
        setDebugLogs((current) => [
          ...current,
          `frontend: backend response received after stop; ignored images=${response.images.length}`,
        ]);
        return;
      }
      setImages(response.images);
      setDebugLogs((current) => [
        ...current,
        `frontend: received images=${response.images.length}`,
      ]);

      const item: HistoryItem = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        prompt: requestForm.prompt,
        settings: requestForm,
        images: response.images,
      };
      setHistory((current) => [item, ...current].slice(0, historyLimit));
      setMessage(
        t("status.savedImages", {
          count: response.images.length,
          path: outputDir,
        }),
      );
      playCompletionSound();
    } catch (error) {
      if (
        cancelledRunIdsRef.current.has(runId) ||
        generationRunIdRef.current !== runId
      ) {
        const errorText = formatErrorText(error);
        setDebugLogs((current) => [
          ...current,
          `frontend: backend error received after stop; ignored error=${errorText.split("\n")[0] || errorText}`,
          ...extractDebugLogs(errorText),
        ]);
        return;
      }
      const errorText = notifyError(error);
      const backendLogs = extractDebugLogs(errorText);
      setDebugLogs((current) => [
        ...current,
        `frontend: error=${errorText.split("\n")[0] || errorText}`,
        ...backendLogs,
      ]);
    } finally {
      backendWaitTimersRef.current.forEach((timer) =>
        window.clearTimeout(timer),
      );
      backendWaitTimersRef.current = [];
      cancelledRunIdsRef.current.delete(runId);
      if (generationRunIdRef.current === runId) {
        setGenerationProgress(null);
        setBusy(false);
      }
    }
  }

  function stopGeneration() {
    if (!busy) {
      return;
    }
    const runId = generationRunIdRef.current;
    cancelledRunIdsRef.current.add(runId);
    backendWaitTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    backendWaitTimersRef.current = [];
    setGenerationProgress(null);
    setBusy(false);
    setMessage(t("status.cancelled"));
    setDebugLogs((current) => [
      ...current,
      `frontend: stop clicked run=${runId}; pending backend response will be ignored`,
    ]);
  }

  async function copyImage(path: string) {
    try {
      await tauriInvoke("copy_image_to_clipboard", { path });
      setMessage(t("status.copiedImage"));
    } catch (error) {
      notifyError(error);
    }
  }

  async function copyErrorDetails() {
    if (!errorDialog) {
      return;
    }
    try {
      await navigator.clipboard.writeText(errorDialog);
      setMessage(t("status.copiedError"));
    } catch (error) {
      notifyError(error);
    }
  }

  async function showImageInFinder(path: string) {
    try {
      await tauriInvoke("show_in_finder", { path });
    } catch (error) {
      notifyError(error);
    }
  }

  async function saveImageAs(path: string) {
    try {
      const savedPath = await tauriInvoke<string>("save_as_image", {
        sourcePath: path,
      });
      setMessage(t("status.savedAs", { path: savedPath }));
    } catch (error) {
      const text = formatErrorText(error);
      if (!text.includes("保存先が選択されませんでした")) {
        notifyError(text);
      }
    }
  }

  async function loadFromHistory(item: HistoryItem) {
    const hydratedItem = await hydrateHistoryItemAssets(item);
    setSelectedHistoryId(item.id);
    const nextSettings = normalizeFormAgainstConfig(
      { ...buildInitialForm(appConfig), ...hydratedItem.settings },
      appConfig,
    );
    setForm(nextSettings);
    setImages(hydratedItem.images);
    setMessage(t("status.loadedHistory"));
  }

  async function loadHistoryImages(items: HistoryItem[]) {
    return Promise.all(items.map(hydrateHistoryItemAssets));
  }

  async function loadImagesDataUrl(imageItems: GeneratedImage[]) {
    return Promise.all(
      imageItems.map(async (image) => {
        if (image.dataUrl) {
          return image;
        }
        try {
          const dataUrl = await tauriInvoke<string>("load_image_data_url", {
            path: image.path,
          });
          return { ...image, dataUrl };
        } catch {
          return image;
        }
      }),
    );
  }

  async function hydrateHistoryItemAssets(
    item: HistoryItem,
  ): Promise<HistoryItem> {
    const inputImages = await loadImageAssetsDataUrl(
      item.settings.inputImages ?? [],
    );
    const maskImage = item.settings.maskImage
      ? await loadMaskAssetForUi(item.settings.maskImage)
      : null;
    return {
      ...item,
      settings: {
        ...item.settings,
        inputImages,
        maskImage,
      },
      images: await loadImagesDataUrl(item.images),
    };
  }

  async function loadImageAssetsDataUrl(assets: ImageAsset[]) {
    return Promise.all(assets.map(loadImageAssetDataUrl));
  }

  async function loadImageAssetDataUrl(asset: ImageAsset): Promise<ImageAsset> {
    if (asset.dataUrl || !asset.path) {
      return asset;
    }
    try {
      const dataUrl = await tauriInvoke<string>("load_image_data_url", {
        path: asset.path,
      });
      const size = await readImageSize(dataUrl);
      return { ...asset, dataUrl, width: size.width, height: size.height };
    } catch {
      return asset;
    }
  }

  async function loadMaskAssetForUi(asset: ImageAsset): Promise<ImageAsset> {
    const loaded = await loadImageAssetDataUrl(asset);
    if (loaded.maskEncoding !== "api-alpha" || !loaded.dataUrl) {
      return loaded;
    }
    return buildUiMaskFromApiMask(loaded);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-icon" src={appIcon} alt="" aria-hidden="true" />
          <div>
            <h1>{t("app.title")}</h1>
            <p>{t("app.subtitle")}</p>
          </div>
        </div>
        <div className="top-actions">
          {!debugOpen && (
            <button
              className="icon-button"
              type="button"
              onClick={() => setDebugOpen(true)}
            >
              <ChevronUp size={18} />
              <span>{t("action.openLogs")}</span>
            </button>
          )}
          <button
            className="icon-button"
            type="button"
            onClick={() => setSettingsOpen(true)}
            title={t("aria.settings")}
          >
            <Settings size={18} />
            <span>{t("button.settings")}</span>
          </button>
        </div>
      </header>

      <main className={`workspace ${debugOpen ? "logs-open" : ""}`}>
        <section
          ref={composerRef}
          className="composer-panel"
          aria-label={t("aria.composer")}
        >
          <div className="panel-heading">
            <SlidersHorizontal size={18} />
            <h2>{t("section.composer")}</h2>
          </div>

          <div className="tabs" role="tablist" aria-label={t("aria.modeTabs")}>
            {tabs.map((tab) => (
              <button
                className={form.mode === tab.id ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={form.mode === tab.id}
                key={tab.id}
                onClick={() =>
                  setForm((current) =>
                    normalizeFormAgainstConfig(
                      {
                        ...current,
                        mode: tab.id,
                        action: actionForMode(tab.id),
                      },
                      appConfig,
                    ),
                  )
                }
              >
                {tab.label}
              </button>
            ))}
          </div>

          <label className="field wide">
            <span>{t("field.prompt")}</span>
            <textarea
              value={form.prompt}
              onChange={(event) => updateForm("prompt", event.target.value)}
              placeholder={t("field.prompt.placeholder")}
            />
          </label>

          {form.mode !== "text" && (
            <ImageInputPanel
              images={form.inputImages}
              onAdd={(files) => addFiles(files, "input")}
              onRemove={removeInputImage}
              t={t}
            />
          )}

          {form.mode === "edit-mask" && (
            <MaskPanel
              baseImage={form.inputImages[0] ?? null}
              maskImage={form.maskImage}
              brushSize={brushSize}
              onBrushSizeChange={setBrushSize}
              onMaskFile={(files) => addFiles(files, "mask")}
              onMaskChange={(maskImage) => updateForm("maskImage", maskImage)}
              onCreateBlankInput={createBlankInputImage}
              t={t}
            />
          )}

          <div className="field-grid">
            <SelectField
              label={t("field.model")}
              value={form.model}
              options={modelOptions()}
              onChange={(value) => updateForm("model", value)}
            />
            <SelectField
              label={t("field.size")}
              value={form.size}
              options={appConfig.sizes}
              onChange={(value) => updateForm("size", value)}
            />
            <SelectField
              label={t("field.quality")}
              value={form.quality}
              options={appConfig.qualities}
              onChange={(value) => updateForm("quality", value)}
            />
            <SelectField
              label={t("field.format")}
              value={form.outputFormat}
              options={appConfig.outputFormats}
              onChange={(value) => updateForm("outputFormat", value)}
            />
            <SelectField
              label={t("field.background")}
              value={form.background}
              options={appConfig.backgrounds}
              onChange={(value) => updateForm("background", value)}
            />
            <SelectField
              label={t("field.moderation")}
              value={form.moderation}
              options={appConfig.moderations}
              onChange={(value) => updateForm("moderation", value)}
            />
          </div>

          <label className={`field ${canCompress ? "" : "disabled"}`}>
            <span>
              {canCompress
                ? t("field.compression", { value: form.outputCompression })
                : t("field.compression.disabled")}
            </span>
            <input
              type="range"
              min={appConfig.limits.outputCompressionMin}
              max={appConfig.limits.outputCompressionMax}
              value={form.outputCompression}
              disabled={!canCompress}
              onChange={(event) =>
                updateForm("outputCompression", Number(event.target.value))
              }
            />
          </label>

          <label className="field">
            <span>{t("field.count", { value: form.count })}</span>
            <input
              type="range"
              min={appConfig.limits.countMin}
              max={appConfig.limits.countMax}
              value={form.count}
              onChange={(event) =>
                updateForm("count", Number(event.target.value))
              }
            />
          </label>

          <button
            className={`primary-action ${busy ? "stop-action" : ""}`}
            type="button"
            onClick={busy ? stopGeneration : generate}
          >
            {busy ? <X size={18} /> : <Play size={18} />}
            <span>{buttonLabel}</span>
          </button>

          {message && <p className="status-line">{message}</p>}
        </section>

        <section className="preview-panel" aria-label={t("aria.preview")}>
          <div className="panel-heading">
            <Download size={18} />
            <h2>{t("section.preview")}</h2>
          </div>

          {images.length === 0 ? (
            <div className="empty-preview">
              <ImageIcon size={38} />
              <p>{t("empty.preview")}</p>
            </div>
          ) : (
            <div className={`image-grid ${previewGridClass(images.length)}`}>
              {images.map((image) => (
                <article
                  className="image-result"
                  key={image.path}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({
                      x: event.clientX,
                      y: event.clientY,
                      image,
                    });
                  }}
                >
                  <img src={image.dataUrl} alt="Generated result" />
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="history-panel" aria-label={t("aria.history")}>
          <div className="panel-heading">
            <History size={18} />
            <h2>{t("section.history")}</h2>
          </div>

          {history.length === 0 ? (
            <p className="history-empty">{t("empty.history")}</p>
          ) : (
            <div className="history-list">
              {history.map((item) => (
                <HistoryButton
                  item={item}
                  selected={selectedHistory?.id === item.id}
                  key={item.id}
                  onClick={() => loadFromHistory(item)}
                />
              ))}
            </div>
          )}
        </aside>

        {debugOpen && (
          <section className="debug-panel" aria-label={t("aria.debug")}>
            <div className="panel-heading">
              <FileText size={18} />
              <h2>{t("section.debug")}</h2>
            </div>
            <div className="debug-actions">
              <button
                type="button"
                onClick={() =>
                  navigator.clipboard.writeText(debugLogs.join("\n"))
                }
              >
                <Copy size={15} />
                <span>{t("action.copyLogs")}</span>
              </button>
              <button type="button" onClick={() => setDebugLogs([])}>
                <Trash2 size={15} />
                <span>{t("action.clearLogs")}</span>
              </button>
              <button type="button" onClick={() => setDebugOpen(false)}>
                <ChevronDown size={15} />
                <span>{t("action.closeLogs")}</span>
              </button>
            </div>
            <pre>
              {debugLogs.length > 0 ? debugLogs.join("\n") : t("empty.logs")}
            </pre>
          </section>
        )}
      </main>

      {contextMenu && (
        <div
          className="context-menu-backdrop"
          onClick={() => setContextMenu(null)}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              type="button"
              onClick={() => {
                showImageInFinder(contextMenu.image.path).finally(() =>
                  setContextMenu(null),
                );
              }}
            >
              {t("action.finder")}
            </button>
            <button
              type="button"
              onClick={() => {
                saveImageAs(contextMenu.image.path).finally(() =>
                  setContextMenu(null),
                );
              }}
            >
              {t("action.saveAs")}
            </button>
            <button
              type="button"
              onClick={() => {
                copyImage(contextMenu.image.path).finally(() =>
                  setContextMenu(null),
                );
              }}
            >
              {t("action.copy")}
            </button>
          </div>
        </div>
      )}

      {errorDialog && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="error-modal"
            role="alertdialog"
            aria-modal="true"
            aria-label={t("aria.error")}
          >
            <div className="modal-heading">
              <h2>{t("modal.error.title")}</h2>
              <button
                type="button"
                onClick={() => setErrorDialog(null)}
                title={t("title.close")}
              >
                <X size={18} />
              </button>
            </div>
            <pre>{errorDialog}</pre>
            <div className="modal-actions">
              <button
                className="secondary-action compact"
                type="button"
                onClick={copyErrorDetails}
              >
                <Copy size={16} />
                <span>{t("action.copyError")}</span>
              </button>
              <button
                className="primary-action compact"
                type="button"
                onClick={() => setErrorDialog(null)}
              >
                <span>{t("action.close")}</span>
              </button>
            </div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("aria.settings")}
          >
            <div className="modal-heading">
              <h2>{t("modal.settings.title")}</h2>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                title={t("title.close")}
              >
                <X size={18} />
              </button>
            </div>
            <SelectField
              label={t("field.language")}
              value={settings.language}
              options={availableLocales.map((item) => ({
                value: item.code,
                label: item.name,
              }))}
              onChange={changeLanguage}
            />
            <label className="field api-key-field">
              <span>{t("field.apiKey")}</span>
              <textarea
                value={settings.apiKey}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    apiKey: event.target.value,
                  }))
                }
                placeholder={t("field.apiKey.placeholder")}
              />
            </label>
            <div className="settings-link-row">
              <button
                className="secondary-action compact"
                type="button"
                onClick={() =>
                  openExternalUrl("https://platform.openai.com/api-keys")
                }
              >
                <span>{t("action.openApiKeys")}</span>
              </button>
              <button
                className="secondary-action compact"
                type="button"
                onClick={() =>
                  openExternalUrl(
                    "https://platform.openai.com/settings/organization/billing/overview",
                  )
                }
              >
                <span>{t("action.openBilling")}</span>
              </button>
            </div>
            <button
              className="primary-action compact"
              type="button"
              onClick={saveSettings}
            >
              <Save size={18} />
              <span>{t("action.save")}</span>
            </button>
          </section>
        </div>
      )}
    </div>
  );
}

function ImageInputPanel({
  images,
  onAdd,
  onRemove,
  t,
}: {
  images: ImageAsset[];
  onAdd: (files: FileList | File[]) => void;
  onRemove: (id: string) => void;
  t: (key: string, replacements?: Record<string, string | number>) => string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    onAdd(event.dataTransfer.files);
  }

  return (
    <section className="asset-panel">
      <div
        className="drop-zone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <Upload size={18} />
        <span>{t("field.uploadImages")}</span>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={(event) => event.target.files && onAdd(event.target.files)}
        />
      </div>
      {images.length > 0 && (
        <div className="asset-grid">
          {images.map((image) => (
            <article className="asset-thumb" key={image.id}>
              <img src={image.dataUrl} alt={image.name} />
              <span title={image.name}>{image.name}</span>
              <button
                type="button"
                onClick={() => onRemove(image.id)}
                title={t("title.delete")}
              >
                <Trash2 size={15} />
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function MaskPanel({
  baseImage,
  maskImage,
  brushSize,
  onBrushSizeChange,
  onMaskFile,
  onMaskChange,
  onCreateBlankInput,
  t,
}: {
  baseImage: ImageAsset | null;
  maskImage: ImageAsset | null;
  brushSize: number;
  onBrushSizeChange: (value: number) => void;
  onMaskFile: (files: FileList | File[]) => void;
  onMaskChange: (maskImage: ImageAsset | null) => void;
  onCreateBlankInput: () => void;
  t: (key: string, replacements?: Record<string, string | number>) => string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !baseImage) {
      return;
    }
    let cancelled = false;

    const image = new Image();
    image.onload = () => {
      if (cancelled) {
        return;
      }
      canvas.width = Math.max(1, image.naturalWidth || image.width);
      canvas.height = Math.max(1, image.naturalHeight || image.height);
      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "rgba(0, 0, 0, 0)";
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (!maskImage?.dataUrl) {
        return;
      }
      const mask = new Image();
      mask.onload = () => {
        if (cancelled) {
          return;
        }
        context.drawImage(mask, 0, 0, canvas.width, canvas.height);
      };
      mask.src = maskImage.dataUrl;
    };
    image.src = baseImage.dataUrl;
    return () => {
      cancelled = true;
    };
  }, [baseImage?.id, maskImage?.id]);

  function draw(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) {
      return;
    }
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const brushScale = (scaleX + scaleY) / 2;
    context.globalCompositeOperation = "source-over";
    context.fillStyle = "rgba(255, 0, 0, 1)";
    context.beginPath();
    context.arc(x, y, (brushSize * brushScale) / 2, 0, Math.PI * 2);
    context.fill();
  }

  function commitMask() {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    onMaskChange({
      id: crypto.randomUUID(),
      name: "drawn-mask.png",
      mimeType: "image/png",
      dataUrl: canvas.toDataURL("image/png"),
      maskEncoding: "ui-red",
      width: canvas.width,
      height: canvas.height,
    });
  }

  function clearMask() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
    onMaskChange(null);
  }

  return (
    <section className="mask-panel">
      <div className="mask-toolbar">
        {!baseImage && (
          <button type="button" onClick={onCreateBlankInput}>
            <ImageIcon size={15} />
            <span>{t("action.createBlankCanvas")}</span>
          </button>
        )}
        <button type="button" onClick={() => fileRef.current?.click()}>
          <Upload size={15} />
          <span>{t("action.loadMask")}</span>
        </button>
        <button type="button" onClick={clearMask}>
          <Eraser size={15} />
          <span>{t("action.clear")}</span>
        </button>
        <label>
          <Brush size={15} />
          <span>{brushSize}px</span>
          <input
            type="range"
            min="8"
            max="96"
            value={brushSize}
            onChange={(event) => onBrushSizeChange(Number(event.target.value))}
          />
        </label>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={(event) =>
            event.target.files && onMaskFile(event.target.files)
          }
        />
      </div>
      <div className="mask-canvas-wrap">
        {baseImage ? (
          <>
            <img src={baseImage.dataUrl} alt="" />
            <canvas
              ref={canvasRef}
              onPointerDown={(event) => {
                drawingRef.current = true;
                (event.target as HTMLCanvasElement).setPointerCapture(
                  event.pointerId,
                );
                draw(event);
              }}
              onPointerMove={draw}
              onPointerUp={(event) => {
                drawingRef.current = false;
                (event.target as HTMLCanvasElement).releasePointerCapture(
                  event.pointerId,
                );
                commitMask();
              }}
              onPointerLeave={() => {
                drawingRef.current = false;
              }}
            />
          </>
        ) : (
          <p>{t("message.addInputFirst")}</p>
        )}
      </div>
      {maskImage && (
        <div className="mask-preview">
          <img src={maskImage.dataUrl} alt="Mask" />
          <span>{maskImage.name}</span>
        </div>
      )}
    </section>
  );
}

function HistoryButton({
  item,
  selected,
  onClick,
}: {
  item: HistoryItem;
  selected: boolean;
  onClick: () => void;
}) {
  const thumbnail =
    item.images[0]?.dataUrl || item.settings.inputImages?.[0]?.dataUrl || "";

  return (
    <button
      className={`history-item ${selected ? "active" : ""}`}
      type="button"
      onClick={onClick}
    >
      {thumbnail ? (
        <img src={thumbnail} alt="" />
      ) : (
        <span className="history-thumb-placeholder">
          <ImageIcon size={20} />
        </span>
      )}
      <span>{new Date(item.createdAt).toLocaleString()}</span>
      <strong>{item.prompt || "(empty prompt)"}</strong>
    </button>
  );
}

function normalizeSettings(
  value: Partial<AppSettings> | null | undefined,
): AppSettings {
  return {
    apiKey: value?.apiKey ?? "",
    language: value?.language || "en",
  };
}

function buildInitialForm(appConfig: AppConfig): GenerateForm {
  return {
    ...appConfig.defaults,
    inputImages: [],
    maskImage: null,
  };
}

function normalizeAppConfig(
  value: Partial<AppConfig> | null | undefined,
): AppConfig {
  const models = coerceOptions(value?.models, fallbackAppConfig.models).filter(
    (option) => !option.value.startsWith("gpt-4"),
  );
  const imageEditModels = coerceOptions(
    value?.imageEditModels,
    fallbackAppConfig.imageEditModels,
  );
  const normalized: AppConfig = {
    defaults: {
      ...fallbackAppConfig.defaults,
      ...(isObject(value?.defaults) ? value?.defaults : {}),
    },
    limits: {
      history: coerceNumber(
        value?.limits?.history,
        fallbackAppConfig.limits.history,
      ),
      countMin: coerceNumber(
        value?.limits?.countMin,
        fallbackAppConfig.limits.countMin,
      ),
      countMax: coerceNumber(
        value?.limits?.countMax,
        fallbackAppConfig.limits.countMax,
      ),
      outputCompressionMin: coerceNumber(
        value?.limits?.outputCompressionMin,
        fallbackAppConfig.limits.outputCompressionMin,
      ),
      outputCompressionMax: coerceNumber(
        value?.limits?.outputCompressionMax,
        fallbackAppConfig.limits.outputCompressionMax,
      ),
      requestDelayMs: coerceNumber(
        value?.limits?.requestDelayMs,
        fallbackAppConfig.limits.requestDelayMs,
      ),
    },
    modes: coerceStringArray(value?.modes, fallbackAppConfig.modes).filter(
      isWorkMode,
    ),
    models: models.length > 0 ? models : fallbackAppConfig.models,
    imageEditModels:
      imageEditModels.length > 0
        ? imageEditModels
        : fallbackAppConfig.imageEditModels,
    sizes: coerceStringArray(value?.sizes, fallbackAppConfig.sizes),
    qualities: coerceStringArray(value?.qualities, fallbackAppConfig.qualities),
    outputFormats: coerceStringArray(
      value?.outputFormats,
      fallbackAppConfig.outputFormats,
    ),
    backgrounds: coerceStringArray(
      value?.backgrounds,
      fallbackAppConfig.backgrounds,
    ),
    moderations: coerceStringArray(
      value?.moderations,
      fallbackAppConfig.moderations,
    ),
  };

  if (normalized.limits.countMin < 1) {
    normalized.limits.countMin = 1;
  }
  if (normalized.limits.countMax < normalized.limits.countMin) {
    normalized.limits.countMax = normalized.limits.countMin;
  }
  if (
    normalized.limits.outputCompressionMax <
    normalized.limits.outputCompressionMin
  ) {
    normalized.limits.outputCompressionMax =
      normalized.limits.outputCompressionMin;
  }
  if (normalized.modes.length === 0) {
    normalized.modes = fallbackAppConfig.modes;
  }

  normalized.defaults = normalizeFormAgainstConfig(
    buildInitialForm(normalized),
    normalized,
  );
  return normalized;
}

function normalizeFormAgainstConfig(
  form: GenerateForm,
  appConfig: AppConfig,
): GenerateForm {
  const defaultForm = buildInitialForm({
    ...appConfig,
    defaults: {
      ...fallbackAppConfig.defaults,
      ...appConfig.defaults,
    },
  });
  const mode = appConfig.modes.includes(form.mode)
    ? form.mode
    : defaultForm.mode;
  const modelOptions = modelsForMode(appConfig, mode);
  return {
    ...form,
    mode,
    model: modelOptions.some((option) => option.value === form.model)
      ? form.model
      : (modelOptions[0]?.value ?? defaultForm.model),
    size: appConfig.sizes.includes(form.size) ? form.size : defaultForm.size,
    quality: appConfig.qualities.includes(form.quality)
      ? form.quality
      : defaultForm.quality,
    outputFormat: appConfig.outputFormats.includes(form.outputFormat)
      ? form.outputFormat
      : defaultForm.outputFormat,
    outputCompression: clampNumber(
      form.outputCompression,
      appConfig.limits.outputCompressionMin,
      appConfig.limits.outputCompressionMax,
    ),
    background: appConfig.backgrounds.includes(form.background)
      ? form.background
      : defaultForm.background,
    moderation: appConfig.moderations.includes(form.moderation)
      ? form.moderation
      : defaultForm.moderation,
    action: actionForMode(mode),
    count: clampNumber(
      form.count,
      appConfig.limits.countMin,
      appConfig.limits.countMax,
    ),
    inputImages: form.inputImages ?? [],
    maskImage: form.maskImage ?? null,
  };
}

function modelsForMode(appConfig: AppConfig, mode: WorkMode) {
  return mode === "edit-mask" ? appConfig.imageEditModels : appConfig.models;
}

function coerceOptions(value: unknown, fallback: SelectOption[]) {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const options = value
    .map((item) => {
      if (typeof item === "string") {
        return { value: item, label: item };
      }
      if (isObject(item) && typeof item.value === "string") {
        return {
          value: item.value,
          label: typeof item.label === "string" ? item.label : item.value,
        };
      }
      return null;
    })
    .filter((item): item is SelectOption => Boolean(item));
  return options.length > 0 ? options : fallback;
}

function coerceStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const strings = value.filter(
    (item): item is string => typeof item === "string",
  );
  return strings.length > 0 ? strings : fallback;
}

function coerceNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkMode(value: string): value is WorkMode {
  return value === "text" || value === "image" || value === "edit-mask";
}

function translate(
  locale: LocaleText,
  key: string,
  replacements: Record<string, string | number> = {},
) {
  let text = locale[key] ?? fallbackLocale[key] ?? key;
  for (const [name, value] of Object.entries(replacements)) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

function actionForMode(mode: WorkMode) {
  return mode === "text" ? "generate" : "edit";
}

function previewGridClass(count: number) {
  if (count <= 1) {
    return "image-grid-1";
  }
  if (count === 2) {
    return "image-grid-2";
  }
  if (count === 3) {
    return "image-grid-3";
  }
  if (count === 4) {
    return "image-grid-4";
  }
  return "image-grid-many";
}

function appendUniqueImage(
  images: GeneratedImage[],
  nextImage: GeneratedImage,
) {
  if (images.some((image) => image.path === nextImage.path)) {
    return images;
  }
  return [...images, nextImage];
}

async function prepareRequestForm(
  form: GenerateForm,
): Promise<{ form: GenerateForm; logs: string[] }> {
  if (form.mode !== "edit-mask" || !form.maskImage) {
    return { form, logs: [] };
  }

  const target = parseOutputSize(form.size);
  if (!target) {
    return {
      form,
      logs: [`frontend: edit-mask normalization skipped size=${form.size}`],
    };
  }

  const inputSizes = await Promise.all(form.inputImages.map(imageAssetSize));
  const maskSize = await imageAssetSize(form.maskImage);
  const inputImages = await Promise.all(
    form.inputImages.map((image, index) =>
      centerCropAssetToPng(
        image,
        target,
        `input-${index + 1}-${target.width}x${target.height}.png`,
      ),
    ),
  );
  const maskImage = await centerCropAssetToPng(
    form.maskImage,
    target,
    `mask-${target.width}x${target.height}.png`,
  );
  const apiMaskImage = await buildApiMaskFromUiMask(
    form.maskImage,
    target,
    `api-mask-${target.width}x${target.height}.png`,
  );

  return {
    form: {
      ...form,
      inputImages,
      maskImage: apiMaskImage,
    },
    logs: [
      `frontend: edit-mask normalization target=${target.width}x${target.height} crop=center output_format=png`,
      `frontend: input_sizes_before=${inputSizes.map((size) => `${size.width}x${size.height}`).join(", ")}`,
      `frontend: mask_size_before=${maskSize.width}x${maskSize.height}`,
      `frontend: input_sizes_after=${inputImages.map((image) => `${image.width}x${image.height}`).join(", ")}`,
      `frontend: ui_mask_size_after=${maskImage.width}x${maskImage.height}`,
      `frontend: api_mask_size_after=${apiMaskImage.width}x${apiMaskImage.height} mode=rgba-rgb-alpha-same black-transparent=edit white-opaque=protected`,
    ],
  };
}

function parseOutputSize(size: string) {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) {
    return null;
  }
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

async function centerCropAssetToPng(
  asset: ImageAsset,
  target: { width: number; height: number },
  name: string,
): Promise<ImageAsset> {
  const canvas = await centerCropAssetToCanvas(asset, target);

  return {
    id: crypto.randomUUID(),
    name,
    mimeType: "image/png",
    dataUrl: canvas.toDataURL("image/png"),
    width: target.width,
    height: target.height,
  };
}

async function buildApiMaskFromUiMask(
  asset: ImageAsset,
  target: { width: number; height: number },
  name: string,
): Promise<ImageAsset> {
  const sourceCanvas = await centerCropAssetToCanvas(asset, target);
  const sourceContext = sourceCanvas.getContext("2d");
  if (!sourceContext) {
    throw new Error("Canvas context is unavailable.");
  }

  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = target.width;
  outputCanvas.height = target.height;
  const outputContext = outputCanvas.getContext("2d");
  if (!outputContext) {
    throw new Error("Canvas context is unavailable.");
  }

  const sourceData = sourceContext.getImageData(
    0,
    0,
    target.width,
    target.height,
  );
  const outputData = outputContext.createImageData(target.width, target.height);
  for (let index = 0; index < sourceData.data.length; index += 4) {
    const painted = sourceData.data[index + 3] > 0;
    const value = painted ? 0 : 255;
    outputData.data[index] = value;
    outputData.data[index + 1] = value;
    outputData.data[index + 2] = value;
    outputData.data[index + 3] = value;
  }
  outputContext.putImageData(outputData, 0, 0);

  return {
    id: crypto.randomUUID(),
    name,
    mimeType: "image/png",
    dataUrl: outputCanvas.toDataURL("image/png"),
    maskEncoding: "api-alpha",
    width: target.width,
    height: target.height,
  };
}

async function buildUiMaskFromApiMask(asset: ImageAsset): Promise<ImageAsset> {
  const image = await loadImageElement(asset.dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, image.naturalWidth || image.width);
  canvas.height = Math.max(1, image.naturalHeight || image.height);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context is unavailable.");
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const source = context.getImageData(0, 0, canvas.width, canvas.height);
  const output = context.createImageData(canvas.width, canvas.height);
  for (let index = 0; index < source.data.length; index += 4) {
    const painted = source.data[index + 3] === 0;
    output.data[index] = 255;
    output.data[index + 1] = 0;
    output.data[index + 2] = 0;
    output.data[index + 3] = painted ? 255 : 0;
  }
  context.putImageData(output, 0, 0);

  return {
    ...asset,
    id: crypto.randomUUID(),
    name: asset.name || "drawn-mask.png",
    mimeType: "image/png",
    dataUrl: canvas.toDataURL("image/png"),
    maskEncoding: "ui-red",
    width: canvas.width,
    height: canvas.height,
  };
}

async function centerCropAssetToCanvas(
  asset: ImageAsset,
  target: { width: number; height: number },
) {
  const image = await loadImageElement(asset.dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context is unavailable.");
  }

  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.max(
    target.width / sourceWidth,
    target.height / sourceHeight,
  );
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const dx = (target.width - drawWidth) / 2;
  const dy = (target.height - drawHeight) / 2;
  context.clearRect(0, 0, target.width, target.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, dx, dy, drawWidth, drawHeight);

  return canvas;
}

function imageFilesFromList(fileList: FileList | File[]) {
  return Array.from(fileList).filter((file) => file.type.startsWith("image/"));
}

function imageFilesFromClipboard(data: DataTransfer | null) {
  if (!data) {
    return [];
  }

  const files = imageFilesFromList(data.files);
  if (files.length > 0) {
    return files;
  }

  return Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

async function validateRequest(
  form: GenerateForm,
  t: (key: string, replacements?: Record<string, string | number>) => string,
) {
  if (form.mode !== "text" && form.inputImages.length === 0) {
    throw new Error(t("message.needInputImage"));
  }
  if (form.mode === "edit-mask" && !form.maskImage) {
    throw new Error(t("message.needMaskImage"));
  }
  if (form.mode === "edit-mask" && form.maskImage) {
    await ensureMaskSizeMatches(form.inputImages[0], form.maskImage, t);
  }
}

async function ensureMaskSizeMatches(
  inputImage: ImageAsset,
  maskImage: ImageAsset,
  t: (key: string, replacements?: Record<string, string | number>) => string,
) {
  const inputSize = await imageAssetSize(inputImage);
  const maskSize = await imageAssetSize(maskImage);
  if (
    inputSize.width === maskSize.width &&
    inputSize.height === maskSize.height
  ) {
    return;
  }

  throw new Error(
    t("message.maskSizeMismatch", {
      inputWidth: inputSize.width,
      inputHeight: inputSize.height,
      maskWidth: maskSize.width,
      maskHeight: maskSize.height,
    }),
  );
}

async function imageAssetSize(image: ImageAsset) {
  if (image.width && image.height) {
    return { width: image.width, height: image.height };
  }

  return readImageSize(image.dataUrl);
}

function formatErrorText(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(message)),
      milliseconds,
    );
    promise.then(resolve, reject).finally(() => window.clearTimeout(timer));
  });
}

function stripHistoryItemForStorage(item: HistoryItem): HistoryItem {
  return {
    ...item,
    settings: {
      ...item.settings,
      inputImages: item.settings.inputImages.map(stripImageAssetData),
      maskImage: item.settings.maskImage
        ? stripImageAssetData(item.settings.maskImage)
        : null,
    },
    images: item.images.map((image) => ({ ...image, dataUrl: "" })),
  };
}

function normalizeStoredHistoryItem(
  item: HistoryItem,
  appConfig: AppConfig,
): HistoryItem {
  return {
    ...item,
    settings: normalizeFormAgainstConfig(
      {
        ...buildInitialForm(appConfig),
        ...item.settings,
        inputImages: (item.settings?.inputImages ?? []).map((image) => ({
          ...image,
          dataUrl: image.dataUrl ?? "",
        })),
        maskImage: item.settings?.maskImage
          ? {
              ...item.settings.maskImage,
              dataUrl: item.settings.maskImage.dataUrl ?? "",
            }
          : null,
      },
      appConfig,
    ),
    images: (item.images ?? []).map((image) => ({
      ...image,
      dataUrl: image.dataUrl ?? "",
    })),
  };
}

function stripImageAssetData(image: ImageAsset): ImageAsset {
  return {
    ...image,
    dataUrl: "",
  };
}

function playCompletionSound() {
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextClass) {
      return;
    }
    const audioContext = new AudioContextClass();
    const now = audioContext.currentTime;
    playTone(audioContext, now, 660, 0.16);
    playTone(audioContext, now + 0.18, 880, 0.2);
    window.setTimeout(() => {
      audioContext.close().catch(() => undefined);
    }, 700);
  } catch {
    // 完了通知音は補助機能なので、失敗しても生成結果の表示を止めない。
  }
}

function playTone(
  audioContext: AudioContext,
  start: number,
  frequency: number,
  duration: number,
) {
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function extractDebugLogs(errorText: string) {
  const marker = "Debug logs:\n";
  const index = errorText.indexOf(marker);
  if (index === -1) {
    return [];
  }
  return errorText
    .slice(index + marker.length)
    .split("\n")
    .filter(Boolean)
    .map((line) => `backend: ${line.replace(/^backend: /, "")}`);
}

function buildFrontendRequestPreview(form: GenerateForm) {
  const usesImagesApi = usesImagesApiModel(form.model);

  if (usesImagesApi && form.mode === "text") {
    const body: Record<string, unknown> = {
      endpoint: "/v1/images/generations",
      model: form.model,
      prompt: form.prompt,
    };
    addImageApiOptions(body, form);
    return JSON.stringify(body, null, 2);
  }

  if (usesImagesApi && (form.mode === "image" || form.mode === "edit-mask")) {
    const fields: Record<string, unknown> = {
      endpoint: "/v1/images/edits",
      contentType: "multipart/form-data",
      model: form.model,
      prompt: form.prompt,
      "image[]": form.inputImages.map((image) => ({
        name: image.name,
        media_type: image.mimeType,
      })),
    };
    if (form.mode === "edit-mask") {
      fields.mask = form.maskImage
        ? {
            name: form.maskImage.name,
            media_type: form.maskImage.mimeType,
          }
        : null;
    }
    addImageApiOptions(fields, form);

    return JSON.stringify(fields, null, 2);
  }

  const tool: Record<string, unknown> = {
    type: "image_generation",
  };
  if (form.quality !== "auto") {
    tool.quality = form.quality;
  }
  if (form.outputFormat !== "auto") {
    tool.output_format = form.outputFormat;
  }
  if (form.background !== "auto") {
    tool.background = form.background;
  }

  if (form.size !== "auto") {
    tool.size = form.size;
  }
  if (form.moderation !== "auto") {
    tool.moderation = form.moderation;
  }
  if (form.action !== "auto") {
    tool.action = form.action;
  }
  if (form.outputFormat === "jpeg" || form.outputFormat === "webp") {
    tool.output_compression = form.outputCompression;
  }
  const input =
    form.mode === "text"
      ? form.prompt
      : [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: form.prompt,
              },
              ...form.inputImages.map((image) => ({
                type: "input_image",
                image_url:
                  form.mode === "edit-mask"
                    ? "<uploaded input file id>"
                    : redactDataUrl(image.dataUrl),
                media_type: image.mimeType,
                name: image.name,
              })),
            ],
          },
        ];

  const body: Record<string, unknown> = {
    model: form.model,
    input,
    tools: [tool],
  };

  body.tool_choice = { type: "image_generation" };

  return JSON.stringify(body, null, 2);
}

function addImageApiOptions(target: Record<string, unknown>, form: GenerateForm) {
  if (form.size !== "auto") {
    target.size = form.size;
  }
  if (form.quality !== "auto") {
    target.quality = form.quality;
  }
  if (form.outputFormat !== "auto") {
    target.output_format = form.outputFormat;
  }
  if (form.background !== "auto") {
    target.background = form.background;
  }
  if (form.moderation !== "auto") {
    target.moderation = form.moderation;
  }
  if (form.outputFormat === "jpeg" || form.outputFormat === "webp") {
    target.output_compression = form.outputCompression;
  }
}

function usesImagesApiModel(model: string) {
  return model.startsWith("gpt-image-") || model === "chatgpt-image-latest";
}

function redactDataUrl(value: string) {
  const marker = ";base64,";
  const index = value.indexOf(marker);
  if (index === -1) {
    return "<invalid data url>";
  }
  const prefix = value.slice(0, index + marker.length);
  const encoded = value.slice(index + marker.length);
  return `${prefix}<base64 omitted: ${encoded.length} chars>`;
}

function ensureTauri(message = fallbackLocale["error.tauriOnly"]) {
  if (!isTauri) {
    throw new Error(message);
  }
}

function readFileAsAsset(file: File): Promise<ImageAsset> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result);
      try {
        const size = await readImageSize(dataUrl);
        resolve({
          id: crypto.randomUUID(),
          name: file.name,
          mimeType: file.type || "image/png",
          dataUrl,
          width: size.width,
          height: size.height,
        });
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readImageSize(
  dataUrl: string,
): Promise<{ width: number; height: number }> {
  return loadImageElement(dataUrl).then((image) => ({
    width: Math.max(1, image.naturalWidth || image.width),
    height: Math.max(1, image.naturalHeight || image.height),
  }));
}

function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to read image size."));
    image.src = dataUrl;
  });
}

type SelectFieldProps = {
  label: string;
  value: string;
  options: Array<string | { value: string; label: string }>;
  onChange: (value: string) => void;
};

function SelectField({ label, value, options, onChange }: SelectFieldProps) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => {
          const optionValue =
            typeof option === "string" ? option : option.value;
          const optionLabel =
            typeof option === "string" ? option : option.label;
          return (
            <option key={optionValue} value={optionValue}>
              {optionLabel}
            </option>
          );
        })}
      </select>
    </label>
  );
}

export default App;
