import BigNumber from 'bignumber.js';

export const BigNumberTransformer = {
  from: (value: any): BigNumber | null | undefined => {
    if (typeof value === 'undefined' || value === null) {
      return value;
    }
    return new BigNumber(value);
  },
  to: (value: any): string | null | undefined => {
    if (typeof value === 'undefined' || value === null) {
      return value;
    }
    return (value as BigNumber).toFixed();
  },
};
