// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { Metadata, asTextContentResult } from 'limrun-v1-mcp/tools/types';

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import Limrun from 'limrun-v1';

export const metadata: Metadata = {
  resource: 'android_instances',
  operation: 'write',
  tags: [],
  httpMethod: 'delete',
  httpPath: '/v1/android_instances/{id}',
  operationId: 'deleteAndroidInstance',
};

export const tool: Tool = {
  name: 'delete_android_instances',
  description: 'Delete Android instance with given name',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  annotations: {
    idempotentHint: true,
  },
};

export const handler = async (client: Limrun, args: Record<string, unknown> | undefined) => {
  const { id, ...body } = args as any;
  const response = await client.androidInstances.delete(id).asResponse();
  return asTextContentResult(await response.text());
};

export default { metadata, tool, handler };
