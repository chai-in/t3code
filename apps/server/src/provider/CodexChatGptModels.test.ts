import { assert, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { chatGptModels } from "./CodexChatGptModels.ts";

it.effect("fills missing reasoning from the account catalog without replacing native options", () =>
  Effect.gen(function* () {
    const reasoning = {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select" as const,
      options: [
        { id: "low", label: "Low" },
        { id: "xhigh", label: "Extra High", isDefault: true },
        { id: "future-effort", label: "future-effort" },
      ],
      currentValue: "xhigh",
    };
    const native: ServerProviderModel[] = [
      {
        slug: "native-reasoning",
        name: "Native",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            { ...reasoning, options: [{ id: "low", label: "Low" }], currentValue: "low" },
          ],
        },
      },
      {
        slug: "native-speed-only",
        name: "Speed only",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "serviceTier",
              label: "Service Tier",
              type: "select",
              options: [{ id: "priority", label: "Fast" }],
            },
          ],
        },
      },
      {
        slug: "native-empty",
        name: "Empty",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ];
    const slugs = [
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "future-model",
      ...native.map((model) => model.slug),
    ];
    const models = slugs.map((slug) => ({
      slug,
      display_name: slug,
      visibility: "list",
      default_reasoning_level: "xhigh",
      supported_reasoning_levels: [
        { effort: "low" },
        null,
        { effort: "" },
        { effort: 42 },
        { effort: "xhigh" },
        { effort: "future-effort" },
      ],
    }));
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ models })))),
    );
    const result = yield* chatGptModels("account-a", native).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    for (const model of result) {
      assert.isFalse(model.isCustom);
      if (model.slug === "native-reasoning") {
        assert.deepEqual(model.capabilities, native[0]!.capabilities);
        continue;
      }
      assert.deepEqual(model.capabilities?.optionDescriptors?.[0], reasoning);
      const selections = [{ id: "reasoningEffort", value: "future-effort" }];
      assert.deepEqual(
        buildExplicitProviderOptionSelectionsFromDescriptors(
          getProviderOptionDescriptors({ caps: model.capabilities!, selections }),
          selections,
        ),
        selections,
      );
    }
    assert.deepEqual(
      result[4]!.capabilities?.optionDescriptors?.slice(1),
      native[1]!.capabilities?.optionDescriptors,
    );
  }),
);

it.effect("keeps unavailable metadata unknown and never invents a default effort", () =>
  Effect.gen(function* () {
    const metadata = [
      {},
      { supported_reasoning_levels: null },
      { supported_reasoning_levels: "high" },
      { supported_reasoning_levels: [] },
      { supported_reasoning_levels: [{ effort: "" }, null] },
      {
        supported_reasoning_levels: [{ effort: "high" }],
        default_reasoning_level: "not-supported",
      },
      { supported_reasoning_levels: [{ effort: "high" }], default_reasoning_level: 42 },
    ];
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              models: metadata.map((fields, index) => ({
                slug: `model-${index}`,
                display_name: `Model ${index}`,
                visibility: "list",
                ...fields,
              })),
            }),
          ),
        ),
      ),
    );
    const result = yield* chatGptModels("account-a", []).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    assert.deepEqual(
      result.slice(0, 5).map((model) => model.capabilities),
      [null, null, null, null, null],
    );
    for (const model of result.slice(5)) {
      assert.deepEqual(model.capabilities?.optionDescriptors, [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [{ id: "high", label: "High" }],
        },
      ]);
    }
  }),
);

it.effect(
  "uses each selected profile's token and the server's visible catalog order and names",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          assert.strictEqual(request.url, "https://api.openai.com/v1/models");
          requests.push(request.headers.authorization!);
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                models:
                  request.headers.authorization === "Bearer account-a"
                    ? [
                        { slug: "second", display_name: "Second from OpenAI", visibility: "list" },
                        { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
                        { slug: "first", display_name: "First from OpenAI", visibility: "list" },
                      ]
                    : [{ slug: "account-b-only", display_name: "B", visibility: "list" }],
              }),
            ),
          );
        }),
      );
      const native = [
        {
          slug: "first",
          name: "Cached first",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
        { slug: "not-entitled", name: "Cached other", isCustom: false, capabilities: null },
      ];
      const a = yield* chatGptModels("account-a", native).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      assert.deepEqual(
        a.map((model) => [model.slug, model.name]),
        [
          ["second", "Second from OpenAI"],
          ["first", "First from OpenAI"],
        ],
      );
      assert.deepEqual(a[1]!.capabilities, native[0]!.capabilities);
      assert.isNull(a[0]!.capabilities);
      const b = yield* chatGptModels("account-b", native).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      assert.deepEqual(
        b.map((model) => model.slug),
        ["account-b-only"],
      );
      assert.deepEqual(requests, ["Bearer account-a", "Bearer account-b"]);
    }),
);

it.effect("does not present a cached catalog as account entitlements when discovery fails", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))),
    );
    const error = yield* Effect.flip(
      chatGptModels("account-a", []).pipe(Effect.provideService(HttpClient.HttpClient, http)),
    );
    assert.strictEqual(error._tag, "ChatGptCatalogError");
  }),
);
