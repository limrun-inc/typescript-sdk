// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { maybeFilter } from 'limrun-v1-mcp/filtering';
import { Metadata, asTextContentResult } from 'limrun-v1-mcp/tools/types';

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import Limrun from 'limrun-v1';

export const metadata: Metadata = {
  resource: 'assets',
  operation: 'write',
  tags: [],
  httpMethod: 'put',
  httpPath: '/v1/assets',
  operationId: 'putAsset',
};

export const tool: Tool = {
  name: 'get_or_create_assets',
  description:
    "When using this tool, always use the `jq_filter` parameter to reduce the response size and improve performance.\n\nOnly omit if you're sure you don't need the data.\n\nCreates an asset and returns upload and download URLs. If there is a corresponding file uploaded in the storage\nwith given name, its MD5 is returned so you can check if a re-upload is necessary. If no MD5 is returned, then\nthere is no corresponding file in the storage so downloading it directly or using it in instances will fail\nuntil you use the returned upload URL to submit the file.\n\n# Response Schema\n```json\n{\n  type: 'object',\n  properties: {\n    id: {\n      type: 'string'\n    },\n    name: {\n      type: 'string'\n    },\n    signedDownloadUrl: {\n      type: 'string'\n    },\n    signedUploadUrl: {\n      type: 'string'\n    },\n    md5: {\n      type: 'string',\n      description: 'Returned only if there is a corresponding file uploaded already.'\n    }\n  },\n  required: [    'id',\n    'name',\n    'signedDownloadUrl',\n    'signedUploadUrl'\n  ]\n}\n```",
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
      },
      jq_filter: {
        type: 'string',
        title: 'jq Filter',
        description:
          'A jq filter to apply to the response to include certain fields. Consult the output schema in the tool description to see the fields that are available.\n\nFor example: to include only the `name` field in every object of a results array, you can provide ".results[].name".\n\nFor more information, see the [jq documentation](https://jqlang.org/manual/).',
      },
    },
    required: ['name'],
  },
  annotations: {
    idempotentHint: true,
  },
};

export const handler = async (client: Limrun, args: Record<string, unknown> | undefined) => {
  const { jq_filter, ...body } = args as any;
  return asTextContentResult(await maybeFilter(jq_filter, await client.assets.getOrCreate(body)));
};

export default { metadata, tool, handler };
