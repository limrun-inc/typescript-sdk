// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { maybeFilter } from 'limrun-v1-mcp/filtering';
import { Metadata, asTextContentResult } from 'limrun-v1-mcp/tools/types';

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import Limrun from 'limrun-v1';

export const metadata: Metadata = {
  resource: 'android_instances',
  operation: 'read',
  tags: [],
  httpMethod: 'get',
  httpPath: '/v1/android_instances',
  operationId: 'listAndroidInstancesV1',
};

export const tool: Tool = {
  name: 'list_android_instances',
  description:
    "When using this tool, always use the `jq_filter` parameter to reduce the response size and improve performance.\n\nOnly omit if you're sure you don't need the data.\n\nList Android instances belonging to given organization\n\n# Response Schema\n```json\n{\n  type: 'array',\n  items: {\n    $ref: '#/$defs/android_instance'\n  },\n  $defs: {\n    android_instance: {\n      type: 'object',\n      properties: {\n        metadata: {\n          type: 'object',\n          properties: {\n            id: {\n              type: 'string'\n            },\n            createdAt: {\n              type: 'string',\n              format: 'date-time'\n            },\n            organizationId: {\n              type: 'string'\n            },\n            displayName: {\n              type: 'string'\n            },\n            labels: {\n              type: 'object',\n              additionalProperties: true\n            },\n            terminatedAt: {\n              type: 'string',\n              format: 'date-time'\n            }\n          },\n          required: [            'id',\n            'createdAt',\n            'organizationId'\n          ]\n        },\n        spec: {\n          type: 'object',\n          properties: {\n            inactivityTimeout: {\n              type: 'string',\n              description: 'After how many minutes of inactivity should the instance be terminated.\\nExample values 1m, 10m, 3h.\\nDefault is 3m.\\nProviding \"0\" disables inactivity checks altogether.'\n            },\n            region: {\n              type: 'string',\n              description: 'The region where the instance will be created. If not given, will be decided based on scheduling clues\\nand availability.'\n            },\n            hardTimeout: {\n              type: 'string',\n              description: 'After how many minutes should the instance be terminated.\\nExample values 1m, 10m, 3h.\\nDefault is \"0\" which means no hard timeout.'\n            }\n          },\n          required: [            'inactivityTimeout',\n            'region'\n          ]\n        },\n        status: {\n          type: 'object',\n          properties: {\n            token: {\n              type: 'string'\n            },\n            state: {\n              type: 'string',\n              enum: [                'unknown',\n                'creating',\n                'ready',\n                'terminated'\n              ]\n            },\n            adbWebSocketUrl: {\n              type: 'string'\n            },\n            endpointWebSocketUrl: {\n              type: 'string'\n            }\n          },\n          required: [            'token',\n            'state'\n          ]\n        }\n      },\n      required: [        'metadata',\n        'spec',\n        'status'\n      ]\n    }\n  }\n}\n```",
  inputSchema: {
    type: 'object',
    properties: {
      labelSelector: {
        type: 'string',
        description:
          'Labels filter to apply to Android instances to return.\nExpects a comma-separated list of key=value pairs (e.g., env=prod,region=us-west).\n',
      },
      region: {
        type: 'string',
        description: 'Region where the instance is scheduled on.',
      },
      state: {
        type: 'string',
        description: 'State filter to apply to Android instances to return.',
        enum: ['unknown', 'creating', 'ready', 'terminated'],
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
  return asTextContentResult(await maybeFilter(jq_filter, await client.androidInstances.list(body)));
};

export default { metadata, tool, handler };
