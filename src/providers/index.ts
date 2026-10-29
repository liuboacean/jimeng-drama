import { DreaminaProvider } from "./dreamina.js";
import { MockProvider } from "./mock.js";
import type { Provider } from "./types.js";

export { DreaminaProvider, MockProvider };
export type { Provider };

export function createProvider(name: "dreamina" | "mock" | "volc"): Provider {
  switch (name) {
    case "mock":
      return new MockProvider();
    case "dreamina":
      return new DreaminaProvider();
    case "volc":
      throw new Error("volc 通道尚未实现（计划 M5）。当前可用：dreamina / mock");
    default:
      return new DreaminaProvider();
  }
}
