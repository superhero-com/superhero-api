import { Encoding, isEncoded } from '@aeternity/aepp-sdk';
import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'isAeAccountAddress', async: false })
export class AeAccountAddressConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      typeof value === 'string' && isEncoded(value, Encoding.AccountAddress)
    );
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a valid account address`;
  }
}
