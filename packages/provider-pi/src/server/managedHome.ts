import type { ProviderInstanceId } from "@t3tools/contracts";
import type * as Path from "effect/Path";

export const managedPiHome = (
  baseDir: string,
  instanceId: ProviderInstanceId,
  path: Path.Path,
): string =>
  // Hex keeps case-distinct provider IDs separate on case-insensitive volumes.
  path.join(baseDir, "provider-homes", "pi", `instance-${Buffer.from(instanceId).toString("hex")}`);
