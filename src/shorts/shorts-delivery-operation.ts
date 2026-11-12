import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ShortsDeliveryActivationService } from './shorts-delivery-activation.service';
import type { ShortsScope } from './shorts-metadata.service';
import type { ShortsDeliveryRetirementService } from './shorts-delivery-retirement.service';
import type { ShortsPrivateInputRetirementService } from './shorts-private-input-retirement.service';
import type { ShortsPrivateReferenceBarriersService } from './shorts-private-reference-barriers.service';
import type { ShortsInputReclamationService } from './shorts-input-reclamation.service';
import type { ShortsStorageRecoveryService } from './shorts-storage-recovery.service';
import type { ShortsInputReclamationReservationsService } from './shorts-input-reclamation-reservations.service';
import type { ShortsInputReclamationPermitsService } from './shorts-input-reclamation-permits.service';
import type { ShortsReclamationReleaseService } from './shorts-reclamation-release.service';
import type { ShortsStorageRecoveriesService } from './shorts-storage-recoveries.service';

const inputPinFields = {
  'reclaim-input': ['scope', 'cid', 'operation'],
  'input-reclamation-status': ['scope', 'operation'],
  'release-input': ['scope', 'operation'],
  'recover-input': ['scope', 'operation'],
};

const privateInputFields = {
  'retire-encoded-inputs': ['scope', 'id', 'sourceKey', 'operation'],
  'retire-private-inputs': ['scope', 'id', 'sourceKey', 'operation'],
  'barrier-enrol': ['scope', 'confirmPermanent'],
  'barrier-reserve': ['scope', 'id', 'scan', 'objectKey'],
  'barrier-seal': ['scope', 'id', 'scan'],
  'barrier-reserve-seal-batch': ['scope', 'scan', 'confirmPermanent', 'items'],
  'barrier-status': ['scope', 'id'],
  'barrier-cancel': ['scope', 'id'],
  ...inputPinFields,
};

export const isPrivateInputOperation = (action: string) =>
  Object.hasOwn(privateInputFields, action);

export interface PrivateInputOperations {
  scope: Readonly<ShortsScope>;
  encoded: Pick<ShortsDeliveryRetirementService, 'retireInputs'>;
  private: Pick<ShortsPrivateInputRetirementService, 'retireInputs'>;
  barriers: Pick<
    ShortsPrivateReferenceBarriersService,
    'enrol' | 'reserve' | 'seal' | 'get' | 'cancel'
  >;
  pins?: {
    coordinator: Pick<ShortsInputReclamationService, 'reclaim' | 'release'>;
    recovery: Pick<ShortsStorageRecoveryService, 'recover'>;
    reservations: Pick<ShortsInputReclamationReservationsService, 'get'>;
    permits: Pick<ShortsInputReclamationPermitsService, 'get'>;
    releases: Pick<ShortsReclamationReleaseService, 'get'>;
    recoveries: Pick<ShortsStorageRecoveriesService, 'get'>;
  };
}

const fields = {
  rollback: ['id', 'nextKey', 'expected', 'operation'],
  ...privateInputFields,
};

const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function privateInputRequest(action: string, request: any) {
  const { scope } = request;
  if (
    !scope ||
    typeof scope !== 'object' ||
    Array.isArray(scope) ||
    Object.keys(scope).length !== 2 ||
    !['ae_uat', 'ae_mainnet'].includes(scope.network) ||
    typeof scope.contract !== 'string' ||
    !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract)
  )
    throw new BadRequestException('Invalid private input operation scope');
  if (Object.hasOwn(inputPinFields, action)) {
    if (
      typeof request.operation !== 'string' ||
      !uuid.test(request.operation) ||
      (action === 'reclaim-input' &&
        (typeof request.cid !== 'string' ||
          !/^b[a-z2-7]{58}$/.test(request.cid)))
    )
      throw new BadRequestException('Invalid input reclamation identity');
    return;
  }
  if (action === 'barrier-enrol') {
    if (request.confirmPermanent !== true)
      throw new BadRequestException(
        'Permanent scope enrollment must be confirmed',
      );
    return;
  }
  if (action === 'barrier-reserve-seal-batch') {
    if (
      request.confirmPermanent !== true ||
      !Array.isArray(request.items) ||
      request.items.length < 1 ||
      request.items.length > 100
    )
      throw new BadRequestException('Invalid permanent barrier batch');
    const ids = new Set<string>(),
      keys = new Set<string>();
    for (const item of request.items) {
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        Object.keys(item).length !== 2 ||
        Object.keys(item).some((key) => !['id', 'objectKey'].includes(key))
      )
        throw new BadRequestException('Invalid barrier batch item');
      privateInputRequest('barrier-reserve', {
        scope,
        scan: request.scan,
        ...item,
      });
      if (ids.has(item.id) || keys.has(item.objectKey))
        throw new BadRequestException('Duplicate barrier batch identity');
      ids.add(item.id);
      keys.add(item.objectKey);
    }
    return;
  }
  const retirement = action.startsWith('retire-');
  if (
    typeof request.id !== 'string' ||
    !(retirement ? /^[a-zA-Z0-9-]{1,80}$/ : uuid).test(request.id) ||
    (retirement &&
      (typeof request.sourceKey !== 'string' ||
        !/^[a-f0-9]{64}$/.test(request.sourceKey) ||
        typeof request.operation !== 'string' ||
        !uuid.test(request.operation))) ||
    (['barrier-reserve', 'barrier-seal'].includes(action) &&
      (typeof request.scan !== 'string' || !uuid.test(request.scan))) ||
    (action === 'barrier-reserve' &&
      (typeof request.objectKey !== 'string' ||
        !/^[a-zA-Z0-9_/-]{1,512}$/.test(request.objectKey) ||
        request.objectKey.includes('//')))
  )
    throw new BadRequestException('Invalid private input operation identity');
}

export function deliveryOperation(action: string, request: any) {
  if (
    !Object.hasOwn(fields, action) ||
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    Object.keys(request).length !== fields[action].length ||
    Object.keys(request).some((key) => !fields[action].includes(key))
  )
    throw new BadRequestException('Invalid delivery operation');
  if (isPrivateInputOperation(action)) {
    privateInputRequest(action, request);
    return { action, request };
  }
  if (
    typeof request.id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(request.id)
  )
    throw new BadRequestException('Invalid delivery operation identity');
  if (
    action === 'rollback' &&
    (typeof request.nextKey !== 'string' ||
      !/^[a-f0-9]{64}$/.test(request.nextKey) ||
      typeof request.operation !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(request.operation) ||
      !request.expected ||
      typeof request.expected.sourceKey !== 'string' ||
      !/^[a-f0-9]{64}$/.test(request.expected.sourceKey) ||
      typeof request.expected.revision !== 'string' ||
      !/^(0|[1-9][0-9]{0,18})$/.test(request.expected.revision) ||
      Object.keys(request.expected).length !== 2)
  )
    throw new BadRequestException('Invalid rollback expectation');
  return { action, request };
}

export async function runDeliveryOperation(
  input: ReturnType<typeof deliveryOperation>,
  activation: ShortsDeliveryActivationService,
  signal: AbortSignal,
  inputs?: PrivateInputOperations,
) {
  const { action, request } = input;
  signal.throwIfAborted();
  if (isPrivateInputOperation(action)) {
    if (
      !inputs ||
      request.scope.network !== inputs.scope.network ||
      request.scope.contract !== inputs.scope.contract
    )
      throw new BadRequestException('Private input deployment scope changed');
    if (Object.hasOwn(inputPinFields, action))
      return runInputPinOperation(action, request, inputs, signal);
    if (
      [
        'barrier-enrol',
        'barrier-reserve',
        'barrier-seal',
        'barrier-reserve-seal-batch',
      ].includes(action)
    ) {
      const flag = process.env.SHORTS_PRIVATE_INPUT_BARRIERS_ENABLED ?? 'false';
      if (!['true', 'false'].includes(flag))
        throw new Error('Invalid private input barrier flag');
      if (flag !== 'true')
        throw new ServiceUnavailableException(
          'Private input barriers are disabled',
        );
    }
    switch (action) {
      case 'retire-encoded-inputs':
        return inputs.encoded.retireInputs(
          request.id,
          request.sourceKey,
          request.operation,
          signal,
        );
      case 'retire-private-inputs':
        return inputs.private.retireInputs(
          request.id,
          request.sourceKey,
          request.operation,
          signal,
        );
      case 'barrier-enrol':
        await inputs.barriers.enrol(inputs.scope);
        return { scope: inputs.scope, enrolled: true, permanent: true };
      case 'barrier-reserve':
        return barrierReceipt(
          await inputs.barriers.reserve(
            inputs.scope,
            request.id,
            request.scan,
            request.objectKey,
          ),
        );
      case 'barrier-seal':
        return barrierReceipt(
          await inputs.barriers.seal(inputs.scope, request.id, request.scan),
        );
      case 'barrier-reserve-seal-batch':
        return reserveAndSealBarriers(request, inputs, signal);
      case 'barrier-status':
        return barrierReceipt(
          await inputs.barriers.get(inputs.scope, request.id),
        );
      case 'barrier-cancel':
        return barrierReceipt(
          await inputs.barriers.cancel(inputs.scope, request.id),
        );
    }
  }
  switch (action) {
    case 'rollback':
      return activation.select(
        request.id,
        request.nextKey,
        request.expected,
        request.operation,
        'rollback',
        signal,
      );
    default:
      throw new BadRequestException('Invalid delivery operation');
  }
}

async function reserveAndSealBarriers(
  request: any,
  inputs: PrivateInputOperations,
  parent: AbortSignal,
) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(120000)]);
  const barriers: ReturnType<typeof barrierReceipt>[] = [];
  for (const item of request.items) {
    signal.throwIfAborted();
    await inputs.barriers.reserve(
      inputs.scope,
      item.id,
      request.scan,
      item.objectKey,
    );
    signal.throwIfAborted();
    const sealed = await inputs.barriers.seal(
      inputs.scope,
      item.id,
      request.scan,
    );
    // Each service call commits independently. On interruption its saved status
    // remains authoritative; do not start another operation after cancellation.
    signal.throwIfAborted();
    barriers.push(barrierReceipt(sealed));
  }
  return {
    scope: inputs.scope,
    scan: request.scan,
    sealed: barriers.length,
    barriers,
  };
}

function barrierReceipt(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    state: row.state,
    scanId: row.scan_id,
    sealScanId: row.seal_scan_id,
    referenceEpoch: String(row.reference_epoch),
    bytes: Number(row.bytes),
    roots: row.roots.length,
    createdAt: row.created_at,
    sealedAt: row.sealed_at,
    cancelledAt: row.cancelled_at,
  };
}

async function runInputPinOperation(
  action: string,
  request: any,
  inputs: PrivateInputOperations,
  signal: AbortSignal,
) {
  const pins = inputs.pins;
  if (!pins)
    throw new ServiceUnavailableException(
      'Input reclamation services unavailable',
    );
  const reservation = await pins.reservations.get(request.operation);
  signal.throwIfAborted();
  if (
    reservation?.roots.some(
      (root) =>
        root.network !== inputs.scope.network ||
        root.contract !== inputs.scope.contract,
    )
  )
    throw new BadRequestException('Input reclamation deployment scope changed');
  if (action === 'reclaim-input') {
    const result = await pins.coordinator.reclaim(
      request.cid,
      request.operation,
      signal,
    );
    return inputPinReceipt(result.reservation, result.permit);
  }
  if (action === 'input-reclamation-status') {
    if (!reservation) return null;
    const [permit, release, recovery] = await Promise.all([
      pins.permits.get(request.operation),
      pins.releases.get(request.operation),
      pins.recoveries.get('unpin', request.operation),
    ]);
    return {
      ...inputPinReceipt(reservation, permit),
      released: !!release,
      recovered: !!recovery,
    };
  }
  if (!reservation)
    throw new BadRequestException('Input reclamation reservation missing');
  const result =
    action === 'release-input'
      ? await pins.coordinator.release(request.operation, signal)
      : await pins.recovery.recover('unpin', request.operation, signal);
  return {
    operation: request.operation,
    inputCid: reservation.inputCid,
    action,
    observedPin: result.observed_pin,
    observedAt: result.observed_at,
  };
}

function inputPinReceipt(reservation: any, permit: any) {
  return {
    operation: reservation?.operationId,
    inputCid: reservation?.inputCid,
    reservationState: reservation?.state,
    roots: reservation?.roots.length ?? 0,
    permit: permit
      ? {
          state: permit.state,
          issuedAt: permit.issuedAt,
          expires: permit.expires,
          quietUntil: permit.quietUntil,
          settledAt: permit.settledAt,
        }
      : null,
  };
}
