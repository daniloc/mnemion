declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.client.txt" {
  const content: string;
  export default content;
}

declare module "*.css" {
  const content: string;
  export default content;
}

declare module "*.ttf" {
  const data: ArrayBuffer;
  export default data;
}

declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
