import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getMint,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { SimpleVault } from "../target/types/simple_vault";

describe("simple_vault — week 9: deposit and share tokens", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const userA = Keypair.generate();
  const userB = Keypair.generate();
  const userWithoutCard = Keypair.generate();

  const UNIT = 1_000_000; // underlying mint has 6 decimals

  let tokenMint: PublicKey;
  let vaultStatePda: PublicKey;
  let vaultTokenAccountPda: PublicKey;
  let shareMintPda: PublicKey;

  const tokenAccounts = new Map<string, PublicKey>();
  const shareAccounts = new Map<string, PublicKey>();

  const cardPda = (user: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("user_card"), vaultStatePda.toBuffer(), user.toBuffer()],
      program.programId
    )[0];

  const key = (user: Keypair) => user.publicKey.toBase58();

  async function fundUser(user: Keypair) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: user.publicKey,
        lamports: 0.005 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(tx, [admin]);
  }

  async function deposit(user: Keypair, amount: number) {
    return program.methods
      .deposit(new anchor.BN(amount))
      .accounts({
        vaultState: vaultStatePda,
        userCard: cardPda(user.publicKey),
        vaultTokenAccount: vaultTokenAccountPda,
        shareMint: shareMintPda,
        userTokenAccount: tokenAccounts.get(key(user)),
        userShareAccount: shareAccounts.get(key(user)),
        user: user.publicKey,
      } as any)
      .signers([user])
      .rpc();
  }

  before(async () => {
    await fundUser(userA);
    await fundUser(userB);

    tokenMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    [vaultStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), tokenMint.toBuffer()],
      program.programId
    );
    [vaultTokenAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_tokens"), tokenMint.toBuffer()],
      program.programId
    );
    [shareMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("share_mint"), tokenMint.toBuffer()],
      program.programId
    );

    // Создаём vault — функциональность недели 8.
    await program.methods
      .initializeVault()
      .accounts({
        vaultState: vaultStatePda,
        vaultTokenAccount: vaultTokenAccountPda,
        shareMint: shareMintPda,
        tokenMint,
        admin: admin.publicKey,
      } as any)
      .rpc();

    // Карточки создаются только пользователям A и B.
    for (const user of [userA, userB]) {
      await program.methods
        .createUserCard()
        .accounts({
          vaultState: vaultStatePda,
          userCard: cardPda(user.publicKey),
          user: user.publicKey,
        } as any)
        .signers([user])
        .rpc();
    }

    // У каждого пользователя есть исходные токены и отдельный share account.
    for (const user of [userA, userB, userWithoutCard]) {
      const userTokenAccount = await createAccount(
        provider.connection,
        admin,
        tokenMint,
        user.publicKey
      );
      const userShareAccount = await createAccount(
        provider.connection,
        admin,
        shareMintPda,
        user.publicKey
      );

      tokenAccounts.set(key(user), userTokenAccount);
      shareAccounts.set(key(user), userShareAccount);

      await mintTo(
        provider.connection,
        admin,
        tokenMint,
        userTokenAccount,
        admin,
        1_000 * UNIT
      );
    }
  });

  it("deposit: A вносит 100 токенов и получает 100 shares", async () => {
    await deposit(userA, 100 * UNIT);

    const userTokens = await getAccount(
      provider.connection,
      tokenAccounts.get(key(userA))!
    );
    const userShares = await getAccount(
      provider.connection,
      shareAccounts.get(key(userA))!
    );
    const vaultTokens = await getAccount(
      provider.connection,
      vaultTokenAccountPda
    );
    const vault = await program.account.vaultState.fetch(vaultStatePda);
    const card = await program.account.userCard.fetch(cardPda(userA.publicKey));

    assert.equal(userTokens.amount, BigInt(900 * UNIT));
    assert.equal(userShares.amount, BigInt(100 * UNIT));
    assert.equal(vaultTokens.amount, BigInt(100 * UNIT));

    assert.equal(vault.totalTokens.toNumber(), 100 * UNIT);
    assert.equal(vault.totalShares.toNumber(), 100 * UNIT);
    assert.equal(card.deposited.toNumber(), 100 * UNIT);
    assert.equal(card.shares.toNumber(), 100 * UNIT);
  });

  it("deposit: B вносит 50 токенов и получает 50 shares", async () => {
    await deposit(userB, 50 * UNIT);

    const userTokens = await getAccount(
      provider.connection,
      tokenAccounts.get(key(userB))!
    );
    const userShares = await getAccount(
      provider.connection,
      shareAccounts.get(key(userB))!
    );
    const vaultTokens = await getAccount(
      provider.connection,
      vaultTokenAccountPda
    );
    const vault = await program.account.vaultState.fetch(vaultStatePda);
    const card = await program.account.userCard.fetch(cardPda(userB.publicKey));
    const shareMint = await getMint(provider.connection, shareMintPda);

    assert.equal(userTokens.amount, BigInt(950 * UNIT));
    assert.equal(userShares.amount, BigInt(50 * UNIT));
    assert.equal(vaultTokens.amount, BigInt(150 * UNIT));

    assert.equal(vault.totalTokens.toNumber(), 150 * UNIT);
    assert.equal(vault.totalShares.toNumber(), 150 * UNIT);
    assert.equal(card.deposited.toNumber(), 50 * UNIT);
    assert.equal(card.shares.toNumber(), 50 * UNIT);
    assert.equal(shareMint.supply, BigInt(150 * UNIT));
  });

  it("deposit: сумма 0 отклоняется", async () => {
    let failed = false;
    try {
      await deposit(userA, 0);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "нулевой депозит должен быть отклонён");
  });

  it("deposit: пользователь без UserCard не может внести токены", async () => {
    let failed = false;
    try {
      await deposit(userWithoutCard, 10 * UNIT);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "депозит без UserCard должен быть отклонён");
  });

  it("deposit: недостаточный баланс токенов отклоняется Token Program", async () => {
    let failed = false;
    try {
      await deposit(userA, 2_000 * UNIT);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "нельзя внести больше доступного баланса");
  });

  it("после неуспешных депозитов состояние vault и карточки не изменилось", async () => {
    const vault = await program.account.vaultState.fetch(vaultStatePda);
    const card = await program.account.userCard.fetch(cardPda(userA.publicKey));
    const vaultTokens = await getAccount(
      provider.connection,
      vaultTokenAccountPda
    );

    assert.equal(vault.totalTokens.toNumber(), 150 * UNIT);
    assert.equal(vault.totalShares.toNumber(), 150 * UNIT);
    assert.equal(card.deposited.toNumber(), 100 * UNIT);
    assert.equal(card.shares.toNumber(), 100 * UNIT);
    assert.equal(vaultTokens.amount, BigInt(150 * UNIT));
  });
});
