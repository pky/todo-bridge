import type { User as FirebaseUser } from 'firebase/auth'

export interface AppUser {
  uid: string
  email: string | null
  displayName: string | null
  photoURL: string | null
  currentSpaceId?: string | null
}

export function mapFirebaseUser(user: FirebaseUser): AppUser {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
  }
}
