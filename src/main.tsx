import { createRoot } from "react-dom/client";
import { App } from "./app";

// StrictMode intentionally omitted: the engine allocates WebGL resources in a
// useMemo, and StrictMode's dev double-mount would construct a second render
// target + materials. Re-enable once resource disposal is wired up.
createRoot(document.getElementById("root")!).render(<App />);
