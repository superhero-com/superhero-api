import { isNameValid } from '@aeternity/aepp-sdk';
import { BadRequestException, PipeTransform } from '@nestjs/common';
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { PROFILE_CHAIN_NAME_MIN_LABEL_LENGTH } from '../profile.constants';

function propertyName(args: ValidationArguments): string {
  return args.property;
}

/**
 * Lowercase letters, digits and hyphens only. The sponsor flow stores and
 * compares the label verbatim (it is never normalized before the on-chain
 * claim), so uppercase and unicode labels — which AENS would normalize
 * internally — must be rejected to avoid a stored-vs-on-chain name mismatch.
 * `isNameValid` still enforces AENS structure (length cap, no leading/trailing
 * hyphen, etc.) on top of this.
 */
const SPONSORED_LABEL_PATTERN = /^[a-z0-9-]+$/;

export function isSponsoredChainNameLabel(value: string): boolean {
  return (
    value.length >= PROFILE_CHAIN_NAME_MIN_LABEL_LENGTH &&
    SPONSORED_LABEL_PATTERN.test(value) &&
    isNameValid(`${value}.chain`)
  );
}

export function IsSponsoredChainNameLabel(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object, fieldName) => {
    registerDecorator({
      name: 'isSponsoredChainNameLabel',
      target: object.constructor,
      propertyName: fieldName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && isSponsoredChainNameLabel(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${propertyName(args)} must be a valid sponsored AENS chain name (at least ${PROFILE_CHAIN_NAME_MIN_LABEL_LENGTH} characters, without .chain)`;
        },
      },
    });
  };
}

export class SponsoredChainNameLabelPipe implements PipeTransform {
  transform(value: unknown, metadata?: { data?: string }): string {
    if (typeof value !== 'string' || !isSponsoredChainNameLabel(value)) {
      const name = metadata?.data || 'parameter';
      throw new BadRequestException(
        `${name} must be a valid sponsored AENS chain name (at least ${PROFILE_CHAIN_NAME_MIN_LABEL_LENGTH} characters, without .chain)`,
      );
    }
    return value;
  }
}
