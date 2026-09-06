/** The shared UI kit. Docs and examples: docs/dev/ui.md. */
export { openDialog, makeButton, type DialogAction, type DialogHandle, type DialogOptions, type DialogSize, type ButtonKind } from "./dialog";
export { confirmDialog, type ConfirmOptions } from "./confirm";
export { toast, clearToasts, type ToastKind, type ToastOptions, type ToastHandle } from "./toast";
export { mountSidePanelHost, openSidePanel, closeSidePanel, sidePanelBack, currentSidePanel, onSidePanelChange, toggleSidePanel, type SidePanelOptions, type SidePanelContext } from "./sidepanel";
export { renderTable, formatCell, type TableColumn, type TableOptions, type TableHandle, type CellFormat } from "./table";
export { icon, iconSvg, iconButton, ICON_NAMES, type IconName } from "./icons";
