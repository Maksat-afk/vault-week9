import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { createMint, getMint, getAccount } from "@solana/spl-token";
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import { SimpleVault } from "../target/types/simple_vault";

describe("simple_vault — week 8: vault skeleton", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const userA = Keypair.generate();
  const userB = Keypair.generate();

  let tokenMint: PublicKey;
  let vaultStatePda: PublicKey;
  let vaultTokenAccountPda: PublicKey;
  let shareMintPda: PublicKey;

  const cardPda = (user: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("user_card"), vaultStatePda.toBuffer(), user.toBuffer()],
      program.programId
    )[0];

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

  before(async () => {
    await fundUser(userA);
    await fundUser(userB);

    tokenMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);

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
  });

  it("initialize_vault: создаёт настройки vault, token account и share mint", async () => {
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

    const vault = await program.account.vaultState.fetch(vaultStatePda);
    assert.equal(vault.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(vault.tokenMint.toBase58(), tokenMint.toBase58());
    assert.equal(vault.vaultTokenAccount.toBase58(), vaultTokenAccountPda.toBase58());
    assert.equal(vault.shareMint.toBase58(), shareMintPda.toBase58());
    assert.equal(vault.totalTokens.toNumber(), 0);
    assert.equal(vault.totalShares.toNumber(), 0);

    const vaultTokenAccount = await getAccount(provider.connection, vaultTokenAccountPda);
    assert.equal(vaultTokenAccount.owner.toBase58(), vaultStatePda.toBase58());
    assert.equal(vaultTokenAccount.mint.toBase58(), tokenMint.toBase58());

    const shareMint = await getMint(provider.connection, shareMintPda);
    assert.equal(shareMint.decimals, 6);
    assert.equal(shareMint.mintAuthority?.toBase58(), vaultStatePda.toBase58());
    assert.equal(shareMint.supply, BigInt(0));
  });

  it("create_user_card: создаёт отдельную PDA-карточку для каждого пользователя", async () => {
    for (const user of [userA, userB]) {
      const userCard = cardPda(user.publicKey);

      await program.methods
        .createUserCard()
        .accounts({
          vaultState: vaultStatePda,
          userCard,
          user: user.publicKey,
        } as any)
        .signers([user])
        .rpc();

      const card = await program.account.userCard.fetch(userCard);
      assert.equal(card.owner.toBase58(), user.publicKey.toBase58());
      assert.equal(card.vault.toBase58(), vaultStatePda.toBase58());
      assert.equal(card.deposited.toNumber(), 0);
      assert.equal(card.shares.toNumber(), 0);
    }

    assert.notEqual(cardPda(userA.publicKey).toBase58(), cardPda(userB.publicKey).toBase58());
  });

  it("create_user_card: повторное создание карточки того же пользователя отклоняется", async () => {
    let failed = false;

    try {
      await program.methods
        .createUserCard()
        .accounts({
          vaultState: vaultStatePda,
          userCard: cardPda(userA.publicKey),
          user: userA.publicKey,
        } as any)
        .signers([userA])
        .rpc();
    } catch {
      failed = true;
    }

    assert.isTrue(failed, "повторное создание PDA-карточки должно завершиться ошибкой");
  });
});
