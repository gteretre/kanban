import GitHubProvider from 'next-auth/providers/github';
import GoogleProvider from 'next-auth/providers/google';
import AzureADProvider from 'next-auth/providers/azure-ad';
import { getAuthorById, getAuthorByEmail, getAuthorByUsername } from '@/lib/queries';
import { createAuthor } from '@/lib/mutations';
import type { Author } from '@/lib/models';
import type { JWT } from 'next-auth/jwt';

function getEnvVar(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Environment variable "${name}" is missing. Please check your .env.local.`);
  return value;
}

function sanitizeEmail(email: string | null | undefined): string {
  if (!email) return '';
  // Basic email validation
  const trimmed = email.trim().toLowerCase();
  const emailRegex = /^[\w.-]+@[\w.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(trimmed) ? trimmed : '';
}

function sanitizeUsername(username: string | null | undefined): string {
  return (
    username
      ?.trim()
      .replace(/[^a-zA-Z0-9_]/g, '')
      .slice(0, 32) || ''
  );
}

function sanitizeName(name: string | null | undefined): string {
  return (
    name
      ?.trim()
      // Allow all unicode letters, numbers, spaces, _ and -
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .slice(0, 64) || ''
  );
}

function sanitizeImage(image: string | null | undefined): string {
  if (!image || typeof image !== 'string') return '/logo.png';
  if (image.startsWith('http') || image.startsWith('/')) return image;
  return '/logo.png';
}

function sanitizeBio(bio: string | null | undefined): string {
  if (!bio || typeof bio !== 'string') return '';
  // Allow all unicode, remove < and >, limit to 300 chars
  return bio.trim().replace(/[<>]/g, '').slice(0, 300);
}

type ProviderUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  role?: string;
  username?: string;
  provider?: string;
};

type ProviderProfile = Record<string, unknown>;

type SessionUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  role?: string;
  username?: string;
};

type Session = {
  user?: SessionUser;
  [key: string]: unknown;
};

export const options = {
  providers: [
    GitHubProvider({
      clientId: getEnvVar('AUTH_GITHUB_ID'),
      clientSecret: getEnvVar('AUTH_GITHUB_SECRET'),
      profile(profile: ProviderProfile): ProviderUser {
        return {
          id: String(profile.id),
          name: (profile.name as string) || (profile.login as string) || '',
          email: (profile.email as string) || '',
          image: (profile.avatar_url as string) || '',
          role: 'GithubUser',
          username: (profile.login as string) || '',
          provider: 'github',
        };
      },
    }),
    GoogleProvider({
      clientId: getEnvVar('AUTH_GOOGLE_ID'),
      clientSecret: getEnvVar('AUTH_GOOGLE_SECRET'),
      profile(profile: ProviderProfile): ProviderUser {
        const email = (profile.email as string) || '';
        const username = email ? email.split('@')[0] : '';
        return {
          id: String(profile.sub),
          name: (profile.name as string) || username || '',
          email,
          image: (profile.picture as string) || '',
          role: 'GoogleUser',
          username,
          provider: 'google',
        };
      },
    }),
    AzureADProvider({
      clientId: getEnvVar('AUTH_AZURE_AD_ID'),
      clientSecret: getEnvVar('AUTH_AZURE_AD_SECRET'),
      tenantId: getEnvVar('AUTH_AZURE_AD_TENANT'),
      profile(profile: ProviderProfile): ProviderUser {
        const email = (profile.email as string) || (profile.upn as string) || '';
        const username = email ? email.split('@')[0] : '';
        return {
          id: String(profile.oid || profile.id || ''),
          name: (profile.name as string) || username || '',
          email,
          image: (profile.picture as string) || '',
          role: 'MicrosoftUser',
          username,
          provider: 'azuread',
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ user, profile }: { user: ProviderUser; profile: ProviderProfile }) {
      const rawEmail = user.email as string | null | undefined;
      const email = sanitizeEmail(rawEmail);
      if (!email) {
        console.error('SignIn: Invalid or missing email.');
        return false;
      }
      let provider = '';
      if (user.role === 'GithubUser') provider = 'github';
      else if (user.role === 'GoogleUser') provider = 'google';
      else if (user.role === 'MicrosoftUser') provider = 'azuread';

      let dbUser: Author | null = null;
      try {
        dbUser = await getAuthorById(profile.id ? String(profile.id) : '');
      } catch (err) {
        console.error('Error in getAuthorById:', err);
      }
      // Always check by email if not found by id
      if (!dbUser) {
        try {
          dbUser = await getAuthorByEmail(email);
        } catch (err) {
          console.error('Error in getAuthorByEmail:', err);
        }
      }

      if (dbUser) {
        if (!dbUser.provider || dbUser.provider !== provider) {
          return '/auth/error?error=EmailOrUsernameExists';
        }
        user.role = dbUser.role;
        user.username = dbUser.username;
        return true;
      }

      const rawUsername = (profile.login as string) || (email ? email.split('@')[0] : '');
      const rawName = user.name as string | null | undefined;
      const rawImage = (profile.avatar_url as string) || (profile.picture as string) || user.image;
      const rawBio = typeof profile.bio === 'string' ? profile.bio : undefined;
      let username = sanitizeUsername(rawUsername);
      if (!username) username = `user_${Date.now().toString().slice(-6)}`;
      const name = sanitizeName(rawName) || username;
      const image = sanitizeImage(rawImage);
      const bio = sanitizeBio(rawBio) || 'I am a freshman here';
      const role = user.role || '';
      try {
        await createAuthor({
          id: profile.id ? String(profile.id) : '',
          name,
          username,
          email,
          image,
          bio,
          role,
          provider,
          createdAt: new Date(),
        });
        user.role = role;
        user.username = username;
      } catch (err: unknown) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code?: number }).code === 11000
        ) {
          return '/auth/error?error=EmailOrUsernameExists';
        }
        console.error('Failed to create user', err);
        return false;
      }
      return true;
    },
    async jwt({ token, user }: { token: JWT; user?: ProviderUser }) {
      if (user) {
        token.role = user.role;
        token.username = user.username;
      } else if (token.username) {
        const dbUser = await getAuthorByUsername(token.username as string);
        if (!dbUser) {
          console.error(
            'JWT callback: Failed to fetch user from DB by username. Aborting the log in process.'
          );
          return null;
        }
        token.role = dbUser.role || 'guy';
        token.username = dbUser.username;
      }
      Object.keys(token).forEach((key) => {
        if (key !== 'role' && key !== 'username') delete (token as Record<string, unknown>)[key];
      });
      return token;
    },
    async session({ session, token }: { session: Session; token: JWT }) {
      session.user = {
        role: (token as Record<string, unknown>).role as string,
        username: (token as Record<string, unknown>).username as string,
      };
      return session;
    },
  },
  pages: {
    error: '/auth/error',
  },
};
