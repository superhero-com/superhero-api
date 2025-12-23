import { ITransaction } from "@/utils/types";

export function isSelfTransferTx(transaction: ITransaction) {
    if (transaction.tx.type !== 'SpendTx') {
        return false;
    }
    return transaction.tx.recipientId === transaction.tx.senderId;
}