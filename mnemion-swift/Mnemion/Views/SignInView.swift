import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @Environment(SessionModel.self) private var session
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession

    var body: some View {
        @Bindable var session = session
        VStack(spacing: 28) {
            VStack(spacing: 8) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 52, weight: .light))
                    .foregroundStyle(.tint)
                Text("Mnemion")
                    .font(.largeTitle.weight(.semibold))
                Text("Shared memory between you and your agents.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Hive")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                TextField("your-hive.workers.dev", text: $session.hiveInput)
                    .textContentType(.URL)
                    .autocorrectionDisabled()
                    #if os(iOS) || os(visionOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    #endif
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(signIn)
            }

            Button(action: signIn) {
                HStack {
                    if session.isSigningIn { ProgressView().controlSize(.small) }
                    Label("Sign in with passkey", systemImage: "person.badge.key")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(session.isSigningIn || session.hiveInput.trimmingCharacters(in: .whitespaces).isEmpty)

            if let error = session.signInError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(32)
        .frame(maxWidth: 420)
    }

    private func signIn() {
        Task { await session.signIn(using: webAuthenticationSession) }
    }
}
