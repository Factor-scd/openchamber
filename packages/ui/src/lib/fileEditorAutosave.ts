export type FileEditorAutosaveGate = {
  autoSaveEnabled: boolean;
  isDirty: boolean;
  canWrite: boolean;
  isSaving: boolean;
  fileLoading: boolean;
  selectedFilePath: string | null | undefined;
  loadedFilePath: string | null;
  /** True when the selected file must never be written as text (binary / non-editable). */
  isNonEditableBinary: boolean;
};

/**
 * Whether the FilesView autosave effect should schedule a debounced save.
 * Incomplete loads and binary files must never trigger a write.
 */
export function shouldScheduleFileAutosave(gate: FileEditorAutosaveGate): boolean {
  if (!gate.autoSaveEnabled || !gate.isDirty || !gate.canWrite || gate.isSaving) {
    return false;
  }
  if (gate.fileLoading || gate.isNonEditableBinary) {
    return false;
  }
  if (!gate.selectedFilePath || gate.loadedFilePath !== gate.selectedFilePath) {
    return false;
  }
  return true;
}

export type FileEditorSaveDraftGate = {
  selectedFilePath: string | null | undefined;
  loadedFilePath: string | null;
  fileLoading: boolean;
  isDirty: boolean;
  draftContent: string;
  fileContent: string;
  isNonEditableBinary: boolean;
};

/**
 * Whether saveDraft may write. Refuses empty drafts against stale content and any binary target.
 */
export function shouldAllowFileDraftSave(gate: FileEditorSaveDraftGate): boolean {
  if (!gate.selectedFilePath || !gate.isDirty) {
    return false;
  }
  if (gate.fileLoading || gate.loadedFilePath !== gate.selectedFilePath || gate.isNonEditableBinary) {
    return false;
  }
  if (gate.draftContent === '' && gate.fileContent !== '' && gate.loadedFilePath !== gate.selectedFilePath) {
    return false;
  }
  return true;
}
