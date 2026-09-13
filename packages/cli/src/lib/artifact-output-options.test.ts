import { Interfaces, Parser } from '@oclif/core';
import {
  artifactOutputFlags,
  artifactOutputsFromFlags,
  type ArtifactOutputFlagValues,
} from './artifact-output-options';

async function parse(argv: string[]): Promise<ArtifactOutputFlagValues> {
  const { flags } = await Parser.parse(argv, {
    flags: artifactOutputFlags as Interfaces.FlagInput,
    strict: false,
  });
  return flags as ArtifactOutputFlagValues;
}

test('parses repeated workspace, test products, and result bundle outputs', async () => {
  const flags = await parse([
    '--output',
    'logs=workspace:artifacts/logs',
    '--output',
    'products=testProducts',
    '--output',
    'xcresult=resultBundle',
  ]);

  expect(artifactOutputsFromFlags(flags, 'test')).toEqual([
    {
      name: 'logs',
      source: 'workspace',
      path: 'artifacts/logs',
      assetName: 'logs',
    },
    { name: 'products', source: 'testProducts', assetName: 'products' },
    { name: 'xcresult', source: 'resultBundle', assetName: 'xcresult' },
  ]);
});

test('splits an output URL only at the first equals sign', async () => {
  const signedUrl = 'https://storage.example/upload?X-Amz-Credential=abc%2Fdate&X-Amz-Signature=a=b==';
  const flags = await parse(['--output', 'logs=workspace:logs', '--output-url', `logs=${signedUrl}`]);

  expect(artifactOutputsFromFlags(flags, 'run')).toEqual([
    {
      name: 'logs',
      source: 'workspace',
      path: 'logs',
      signedUploadUrl: signedUrl,
    },
  ]);
});

test('applies output TTL only to SDK-presigned assets', async () => {
  const flags = await parse([
    '--output',
    'logs=workspace:logs',
    '--output',
    'report=workspace:report.json',
    '--output-url',
    'report=https://storage.example/upload?sig=a=b',
    '--output-ttl',
    '24h',
  ]);

  expect(artifactOutputsFromFlags(flags, 'run')).toEqual([
    {
      name: 'logs',
      source: 'workspace',
      path: 'logs',
      assetName: 'logs',
      ttl: '24h',
    },
    {
      name: 'report',
      source: 'workspace',
      path: 'report.json',
      signedUploadUrl: 'https://storage.example/upload?sig=a=b',
    },
  ]);
});

test('rejects source and path mistakes before instance resolution', async () => {
  expect(() => artifactOutputsFromFlags({ output: ['products=testProducts'] }, 'build')).toThrow(
    'only valid with lim xcode test',
  );
  expect(() => artifactOutputsFromFlags({ output: ['result=resultBundle'] }, 'run')).toThrow(
    'only valid with xcode build or xcode test',
  );
  expect(() => artifactOutputsFromFlags({ output: ['logs=workspace:../outside'] }, 'run')).toThrow(
    'contain no .. segment',
  );
  expect(() =>
    artifactOutputsFromFlags(
      {
        output: ['logs=workspace:logs'],
        'output-url': ['other=https://storage.example/upload'],
      },
      'run',
    ),
  ).toThrow('undeclared output "other"');
});
