import { Encoding, isEncoded } from '@aeternity/aepp-sdk';
import { BadRequestException, PipeTransform } from '@nestjs/common';
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

const CHAIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}\.chain$/i;
const INVITE_CODE_PATTERN = /^[a-z0-9]{1,64}$/i;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/i;
const POST_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._~:-]{0,127}$/u;
const TOPIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/;

type ValidatorFn = (value: string) => boolean;

function propertyName(args: ValidationArguments): string {
  return args.property;
}

function registerStringValidator(
  name: string,
  validator: ValidatorFn,
  defaultMessage: (args: ValidationArguments) => string,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name,
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && validator(value);
        },
        defaultMessage,
      },
    });
  };
}

export function isAeEncoded(
  value: unknown,
  encoding: (typeof Encoding)[keyof typeof Encoding],
): value is string {
  return typeof value === 'string' && isEncoded(value, encoding);
}

export function isAeAccountAddress(value: unknown): value is string {
  return isAeEncoded(value, Encoding.AccountAddress);
}

export function isAeContractAddress(value: unknown): value is string {
  return isAeEncoded(value, Encoding.ContractAddress);
}

export function isAeTransactionHash(value: unknown): value is string {
  return isAeEncoded(value, Encoding.TxHash);
}

export function isAeAccountReference(value: unknown): value is string {
  return (
    isAeAccountAddress(value) ||
    (typeof value === 'string' && CHAIN_NAME_PATTERN.test(value))
  );
}

export function IsAeAccountAddress(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return registerStringValidator(
    'isAeAccountAddress',
    isAeAccountAddress,
    (args) => `${propertyName(args)} must be a valid account address`,
    validationOptions,
  );
}

abstract class StringValidationPipe implements PipeTransform {
  protected abstract readonly description: string;
  protected abstract isValid(value: string): boolean;

  transform(value: unknown, metadata?: { data?: string }): string {
    if (typeof value !== 'string' || !this.isValid(value)) {
      const name = metadata?.data || 'parameter';
      throw new BadRequestException(`${name} must be ${this.description}`);
    }
    return value;
  }
}

abstract class OptionalStringValidationPipe extends StringValidationPipe {
  transform(value: unknown, metadata?: { data?: string }): string | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    return super.transform(value, metadata);
  }
}

export class AeAccountAddressPipe extends StringValidationPipe {
  protected readonly description = 'a valid account address';

  protected isValid(value: string): boolean {
    return isAeAccountAddress(value);
  }
}

export class OptionalAeAccountAddressPipe extends OptionalStringValidationPipe {
  protected readonly description = 'a valid account address';

  protected isValid(value: string): boolean {
    return isAeAccountAddress(value);
  }
}

export class AeAccountReferencePipe extends StringValidationPipe {
  protected readonly description = 'a valid account address or .chain name';

  protected isValid(value: string): boolean {
    return isAeAccountReference(value);
  }
}

export class AeContractAddressPipe extends StringValidationPipe {
  protected readonly description = 'a valid contract address';

  protected isValid(value: string): boolean {
    return isAeContractAddress(value);
  }
}

export class OptionalAeContractAddressPipe extends OptionalStringValidationPipe {
  protected readonly description = 'a valid contract address';

  protected isValid(value: string): boolean {
    return isAeContractAddress(value);
  }
}

export class AeTransactionHashPipe extends StringValidationPipe {
  protected readonly description = 'a valid transaction hash';

  protected isValid(value: string): boolean {
    return isAeTransactionHash(value);
  }
}

export class InviteCodePipe extends StringValidationPipe {
  protected readonly description = 'a valid invite code';

  protected isValid(value: string): boolean {
    return INVITE_CODE_PATTERN.test(value);
  }
}

export class ProviderParamPipe extends StringValidationPipe {
  protected readonly description = 'a valid provider';

  protected isValid(value: string): boolean {
    return PROVIDER_PATTERN.test(value);
  }
}

export class OpaqueIdPipe extends StringValidationPipe {
  protected readonly description = 'a valid identifier';

  protected isValid(value: string): boolean {
    return POST_ID_PATTERN.test(value);
  }
}

export class TopicParamPipe extends StringValidationPipe {
  protected readonly description = 'a valid topic';

  protected isValid(value: string): boolean {
    return TOPIC_PATTERN.test(value);
  }
}
