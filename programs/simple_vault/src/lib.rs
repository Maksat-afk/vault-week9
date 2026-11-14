use anchor_lang::prelude::*;
use anchor_spl::token::{
    self, Mint, MintTo, Token, TokenAccount, Transfer,
};

declare_id!("FHaFb2vHDtRqnKP8Tm6dMBRLjXWkg8LoW1yvgCHneade");

#[program]
pub mod simple_vault {
    use super::*;

    /// Создаёт базовую структуру vault для выбранного SPL-токена.
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;

        vault.admin = ctx.accounts.admin.key();
        vault.token_mint = ctx.accounts.token_mint.key();
        vault.vault_token_account = ctx.accounts.vault_token_account.key();
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.total_tokens = 0;
        vault.total_shares = 0;
        vault.bump = ctx.bumps.vault_state;

        msg!("Vault initialized: {}", vault.key());
        msg!("Share mint initialized: {}", vault.share_mint);
        Ok(())
    }

    /// Создаёт одну персональную PDA-карточку пользователя для данного vault.
    pub fn create_user_card(ctx: Context<CreateUserCard>) -> Result<()> {
        let card = &mut ctx.accounts.user_card;

        card.vault = ctx.accounts.vault_state.key();
        card.owner = ctx.accounts.user.key();
        card.deposited = 0;
        card.shares = 0;
        card.bump = ctx.bumps.user_card;

        msg!("User card created for: {}", card.owner);
        Ok(())
    }

    /// Пользователь вносит SPL-токены и получает share-токены.
    ///
    /// Первый депозит: shares = amount.
    /// Последующие: shares = amount * total_shares / total_tokens.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);

        let vault = &ctx.accounts.vault_state;

        let shares = if vault.total_shares == 0 || vault.total_tokens == 0 {
            amount
        } else {
            (amount as u128)
                .checked_mul(vault.total_shares as u128)
                .and_then(|value| value.checked_div(vault.total_tokens as u128))
                .and_then(|value| u64::try_from(value).ok())
                .ok_or(VaultError::MathOverflow)?
        };

        require!(shares > 0, VaultError::SharesTooSmall);

        // 1. Переводим базовые токены с пользовательского аккаунта в vault.
        // Пользователь подписывает этот CPI как authority своего token account.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        // 2. Выпускаем share-токены пользователю.
        // Mint authority — VaultState PDA, поэтому программа подписывает CPI seeds.
        let token_mint_key = ctx.accounts.vault_state.token_mint;
        let bump_seed = [ctx.accounts.vault_state.bump];
        let signer_seeds: &[&[u8]] = &[
            b"vault",
            token_mint_key.as_ref(),
            &bump_seed,
        ];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.user_share_account.to_account_info(),
                    authority: ctx.accounts.vault_state.to_account_info(),
                },
                &[signer_seeds],
            ),
            shares,
        )?;

        // 3. Обновляем состояние vault и персональную карточку пользователя.
        let vault = &mut ctx.accounts.vault_state;
        vault.total_tokens = vault
            .total_tokens
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        vault.total_shares = vault
            .total_shares
            .checked_add(shares)
            .ok_or(VaultError::MathOverflow)?;

        let card = &mut ctx.accounts.user_card;
        card.deposited = card
            .deposited
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        card.shares = card
            .shares
            .checked_add(shares)
            .ok_or(VaultError::MathOverflow)?;

        msg!(
            "Deposit: {} tokens -> {} shares (total_tokens={}, total_shares={})",
            amount,
            shares,
            vault.total_tokens,
            vault.total_shares
        );

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Instruction accounts
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    /// VaultState PDA: ["vault", token_mint]
    #[account(
        init,
        payer = admin,
        space = VaultState::LEN,
        seeds = [b"vault", token_mint.key().as_ref()],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,

    /// SPL token account owned by VaultState PDA.
    #[account(
        init,
        payer = admin,
        token::mint = token_mint,
        token::authority = vault_state,
        seeds = [b"vault_tokens", token_mint.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Share-token mint. The vault PDA is its mint authority.
    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = vault_state,
        seeds = [b"share_mint", token_mint.key().as_ref()],
        bump
    )]
    pub share_mint: Account<'info, Mint>,

    pub token_mint: Account<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CreateUserCard<'info> {
    #[account(
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        init,
        payer = user,
        space = UserCard::LEN,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_card: Account<'info, UserCard>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Карточка должна принадлежать этому пользователю и этому vault.
    #[account(
        mut,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump = user_card.bump,
        constraint = user_card.vault == vault_state.key() @ VaultError::InvalidUserCard,
        constraint = user_card.owner == user.key() @ VaultError::InvalidUserCard
    )]
    pub user_card: Account<'info, UserCard>,

    /// PDA-токен-аккаунт vault, принимающий базовые токены.
    #[account(
        mut,
        seeds = [b"vault_tokens", vault_state.token_mint.as_ref()],
        bump,
        token::mint = vault_state.token_mint,
        token::authority = vault_state
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Share mint, которым управляет vault PDA.
    #[account(
        mut,
        seeds = [b"share_mint", vault_state.token_mint.as_ref()],
        bump,
        mint::authority = vault_state
    )]
    pub share_mint: Account<'info, Mint>,

    /// Базовый SPL token account пользователя.
    #[account(
        mut,
        token::mint = vault_state.token_mint,
        token::authority = user
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    /// SPL token account пользователя для получаемых shares.
    #[account(
        mut,
        token::mint = share_mint,
        token::authority = user
    )]
    pub user_share_account: Account<'info, TokenAccount>,

    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// Account state
// -----------------------------------------------------------------------------

#[account]
#[derive(Default)]
pub struct VaultState {
    pub admin: Pubkey,
    pub token_mint: Pubkey,
    pub vault_token_account: Pubkey,
    pub share_mint: Pubkey,
    pub total_tokens: u64,
    pub total_shares: u64,
    pub bump: u8,
}

impl VaultState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 1;
}

#[account]
#[derive(Default)]
pub struct UserCard {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub deposited: u64,
    pub shares: u64,
    pub bump: u8,
}

impl UserCard {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Shares would be zero - deposit too small")]
    SharesTooSmall,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("User card does not belong to this user or vault")]
    InvalidUserCard,
}
