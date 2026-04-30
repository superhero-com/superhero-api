import { isAeAccountAddress } from '@/common/validation/request-validation';
import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'isAeAccountAddress', async: false })
export class AeAccountAddressConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isAeAccountAddress(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a valid account address`;
  }
}
