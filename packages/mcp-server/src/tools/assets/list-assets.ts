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
  httpPath: '/v1/assets',
  operationId: 'listAssets',
};

export const tool: Tool = {
  name: 'list_assets',
  description:
    "When using this tool, always use the `jq_filter` parameter to reduce the response size and improve performance.\n\nOnly omit if you're sure you don't need the data.\n\nList organization's all assets with given filters. If none given, return all assets.\n\n# Response Schema\n```json\n{\n  type: 'array',\n  items: {\n    $ref: '#/$defs/asset'\n  },\n  $defs: {\n    asset: {\n      type: 'object',\n      properties: {\n        id: {\n          type: 'string'\n        },\n        name: {\n          type: 'string'\n        },\n        md5: {\n          type: 'string',\n          description: 'Returned only if there is a corresponding file uploaded already.'\n        },\n        signedDownloadUrl: {\n          type: 'string'\n        },\n        signedUploadUrl: {\n          type: 'string'\n        }\n      },\n      required: [        'id',\n        'name'\n      ]\n    }\n  }\n}\n```",
  inputSchema: {
    type: 'object',
    properties: {
      includeDownloadUrl: {
        type: 'boolean',
        description: 'Toggles whether a download URL should be included in the response',
      },
      includeUploadUrl: {
        type: 'boolean',
        description: 'Toggles whether an upload URL should be included in the response',
      },
      md5Filter: {
        type: 'string',
        description: 'Query by file md5',
      },
      nameFilter: {
        type: 'string',
        description: 'Query by file name',
      },
      jq_filter: {
        type: 'string',
        title: 'jq Filter',
        description:
          'A jq filter to apply to the response to include certain fields. Consult the output schema in the tool description to see the fields that are available.\n\nFor example: to include only the `name` field in every object of a results array, you can provide ".results[].name".\n\nFor more information, see the [jq documentation](https://jqlang.org/manual/).',
      },
    },
    required: [],
  },
  annotations: {
    readOnlyHint: true,
  },
};

export const handler = async (client: Limrun, args: Record<string, unknown> | undefined) => {
  const { jq_filter, ...body } = args as any;
  return asTextContentResult(await maybeFilter(jq_filter, await client.assets.list(body)));
};

export default { metadata, tool, handler };
