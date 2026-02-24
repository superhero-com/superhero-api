import {
  IsString,
  Length,
  Matches,
  ValidateIf,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'xAttestationAuth', async: false })
export class XAttestationAuthConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments) {
    const dto = args.object as CreateXAttestationDto;
    const hasToken = !!dto.accessToken;
    const hasCodeFlow = !!dto.code && !!dto.code_verifier && !!dto.redirect_uri;
    if (hasToken && !hasCodeFlow) return true;
    if (!hasToken && hasCodeFlow) return true;
    return false;
  }

  defaultMessage() {
    return 'Provide either accessToken or (code, code_verifier, redirect_uri)';
  }
}

/**
 * Either { address, accessToken } or { address, code, code_verifier, redirect_uri }.
 * When using the code flow, backend exchanges the code for an access token then creates the attestation.
 */
export class CreateXAttestationDto {
  @IsString()
  @Matches(/^ak_[1-9A-HJ-NP-Za-km-z]+$/)
  address: string;

  /** When using token flow: provide the X OAuth access token directly */
  @ValidateIf((o) => !o.code)
  @IsString()
  @Length(10, 4096)
  accessToken?: string;

  /** When using code flow: authorization code from X redirect (e.g. /profile/x/callback?code=...) */
  @ValidateIf((o) => !o.accessToken)
  @IsString()
  @Length(1, 2048)
  code?: string;

  /** When using code flow: PKCE code_verifier (must match the code_challenge used at authorize) */
  @ValidateIf((o) => !o.accessToken)
  @IsString()
  @Length(43, 128)
  code_verifier?: string;

  /** When using code flow: redirect_uri must match the one used at authorize */
  @ValidateIf((o) => !o.accessToken)
  @IsString()
  @Length(1, 2048)
  redirect_uri?: string;

  @Validate(XAttestationAuthConstraint)
  _auth?: unknown;
}
