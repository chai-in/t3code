import { TrimmedNonEmptyString, type ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { codexReasoningDescriptor } from "./CodexProvider.ts";

export class ChatGptCatalogError extends Schema.TaggedError<ChatGptCatalogError>()(
  "ChatGptCatalogError",
  { status: Schema.Int },
) {}

const Catalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.NonEmptyString,
      display_name: Schema.NonEmptyString,
      visibility: Schema.String,
      supported_reasoning_levels: Schema.optionalKey(Schema.Unknown),
      default_reasoning_level: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});

const decodeReasoningLevels = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));
const decodeReasoningLevel = Schema.decodeUnknownOption(
  Schema.Struct({ effort: TrimmedNonEmptyString }),
);

function modelCapabilities(
  model: (typeof Catalog.Type)["models"][number],
  native: ServerProviderModel | undefined,
) {
  const capabilities = native?.capabilities;
  if (capabilities?.optionDescriptors?.some((descriptor) => descriptor.id === "reasoningEffort"))
    return capabilities;
  const levels = Option.getOrElse(
    decodeReasoningLevels(model.supported_reasoning_levels),
    () => [],
  );
  const reasoning = codexReasoningDescriptor({
    model: model.slug,
    supportedReasoningEfforts: levels.flatMap((level) =>
      Option.match(decodeReasoningLevel(level), {
        onNone: () => [],
        onSome: ({ effort }) => [{ reasoningEffort: effort }],
      }),
    ),
    defaultReasoningEffort:
      typeof model.default_reasoning_level === "string" ? model.default_reasoning_level : undefined,
  });
  if (!reasoning) return capabilities ?? null;
  return {
    ...capabilities,
    optionDescriptors: [reasoning, ...(capabilities?.optionDescriptors ?? [])],
  };
}

export const chatGptModels = Effect.fn("chatGptModels")(function* (
  accessToken: string,
  nativeModels: ReadonlyArray<ServerProviderModel>,
) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.execute(
    HttpClientRequest.get("https://api.openai.com/v1/models").pipe(
      HttpClientRequest.bearerToken(accessToken),
    ),
  );
  if (response.status !== 200) return yield* new ChatGptCatalogError({ status: response.status });
  const catalog = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Catalog)));
  return catalog.models
    .filter((model) => model.visibility === "list")
    .map((model) => {
      const native = nativeModels.find((candidate) => candidate.slug === model.slug);
      return {
        ...native,
        capabilities: modelCapabilities(model, native),
        slug: model.slug,
        name: model.display_name,
        isCustom: false,
      } satisfies ServerProviderModel;
    });
}, Effect.timeout("15 seconds"));
