import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
const style = document.createElement("style");
style.textContent = `html, body, #root { margin: 0; padding: 0; min-height: 100%; } body { -webkit-text-size-adjust: 100%; }`;
document.head.appendChild(style);
ReactDOM.createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
