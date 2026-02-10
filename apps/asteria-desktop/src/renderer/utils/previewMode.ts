const UI_PREVIEW_QUERY_PARAM = "uiPreview";

const getSearch = (): string => {
  const windowRef = globalThis as typeof globalThis & { location?: { search?: string } };
  return windowRef.location?.search ?? "";
};

export const isUiPreviewModeEnabled = (search = getSearch()): boolean => {
  if (!search) return false;
  try {
    const previewValue = new URLSearchParams(search).get(UI_PREVIEW_QUERY_PARAM);
    return previewValue === "1" || previewValue === "true";
  } catch {
    return false;
  }
};

