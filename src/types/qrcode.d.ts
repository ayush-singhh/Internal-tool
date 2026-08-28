/** `qrcode` ships no types. This is the one call the app makes — a devDependency on
 *  @types/qrcode would be a bigger diff than the four lines it saves. */
declare module "qrcode" {
  export function toDataURL(
    text: string,
    options?: { margin?: number; width?: number; scale?: number },
  ): Promise<string>;
}
