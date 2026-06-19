import { encodeGeneric } from "@blackwell-systems/gcf";

export function encodeToToon(value: unknown): string {
  return encodeGeneric(value);
}
