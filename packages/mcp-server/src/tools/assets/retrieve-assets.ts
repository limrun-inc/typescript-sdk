// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { maybeFilter } from 'limrun-v1-mcp/filtering';
import { Metadata, asTextContentResult } from 'limrun-v1-mcp/tools/types';

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import Limrun from 'limrun-v1';

export const metadata: Metadata = {
  resource: 'assets',
  operation: 'read',
  tags: [],
  httpMethod: 'get',
  httpPath: '/v1/assets/{assetId}',
  operationId: 'getAsset',
};

export const tool: Tool = {
  name: 'retrieve_assets',
  description:
    "When using this tool, always use the `jq_filter` parameter to reduce the response size and improve performance.\n\nOnly omit if you're sure you don't need the data.\n\nGet the asset with given ID.\n\n# Response Schema\n```json\n{\n  $ref: '#/$defs/asset',\n  $defs: {\n    asset: {\n      type: 'object',\n      properties: {\n        id: {\n          type: 'string'\n        },\n        name: {\n          type: 'string'\n        },\n        md5: {\n          type: 'string',\n          description: 'Returned only if there is a corresponding file uploaded already.'\n        },\n        signedDownloadUrl: {\n          type: 'string'\n        },\n        signedUploadUrl: {\n          type: 'string'\n        }\n      },\n      required: [        'id',\n        'name'\n      ]\n    }\n  }\n}\n```",
  inputSchema: {
    type: 'object',
    properties: {
      assetId: {
        type: 'string',
      },
      includeDownloadUrl: {
        type: 'boolean',
        description: 'Toggles whether a download URL should be included in the response',
      },
      includeUploadUrl: {
        type: 'boolean',
        description: 'Toggles whether an upload URL should be included in the response',
      },
      jq_filter: {
        type: 'string',
        title: 'jq Filter',
        description:
          'A jq filter to apply to the response to include certain fields. Consult the output schema in the tool description to see the fields that are available.\n\nFor example: to include only the `name` field in every object of a results array, you can provide ".results[].name".\n\nFor more information, see the [jq documentation](https://jqlang.org/manual/).',
      },
    },
    required: ['assetId'],
  },
  annotations: {
    readOnlyHint: true,
  },
};

export const handler = async (client: Limrun, args: Record<string, unknown> | undefined) => {
  const { assetId, jq_filter, ...body } = args as any;
  return asTextContentResult(await maybeFilter(jq_filter, await client.assets.retrieve(assetId, body)));
};

export default { metadata, tool, handler };
