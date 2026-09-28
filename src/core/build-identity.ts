declare const __DANLINGO_BUILD_ID__: string;

export const BUILD_ID = typeof __DANLINGO_BUILD_ID__ === 'string'
  ? __DANLINGO_BUILD_ID__
  : 'unbuilt';
