export type AdditionalFileFlag = {
  localPath: string;
  remotePath: string;
};

export function parseAdditionalFileFlags(values: string[] | undefined): AdditionalFileFlag[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  return values.map((value) => {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(
        `Invalid --additional-file value "${value}". Expected localPath=remotePath, for example ~/.netrc=~/.netrc`,
      );
    }
    return {
      localPath: value.slice(0, separator),
      remotePath: value.slice(separator + 1),
    };
  });
}
