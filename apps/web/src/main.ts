import "./style.css";

// Just the shell for now - the grid gets mounted into #sheet once it exists.
const status = document.getElementById("status-left")!;

const hasWebGPU = "gpu" in navigator;
document.getElementById("status-right")!.textContent = hasWebGPU
  ? "WebGPU available"
  : "WebGPU not available (CPU fallback)";

status.textContent = "Ready";
