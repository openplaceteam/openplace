<template>
	<form class="form" :disabled="loading ? 'disabled' : null" @submit="submit">
		<h2 class="head">Welcome aboard!</h2>

		<InputText
			v-model="username"
			placeholder="Username"
			aria-label="Username"
			autocomplete="username"
			required
			autofocus
			:disabled="loading"
		/>

		<InputText
			v-model="password"
			placeholder="Password"
			aria-label="Password"
			type="password"
			autocomplete="new-password"
			required
			minlength="8"
			:disabled="loading"
		/>

		<Message v-if="errorMessage" severity="error">
			{{ errorMessage }}
		</Message>

		<div class="buttons-container">
			<Button severity="primary" type="submit" :disabled="loading">
				Register
			</Button>
		</div>

		<div class="agreement">
			By registering, you agree to the rules set by the owner of this instance.
		</div>

		<div class="reset-link">
			Already have an account?
			<RouterLink :to="loginURL">
				Log in
			</RouterLink>
		</div>
	</form>
</template>

<script setup lang="ts">
import Button from "primevue/button";
import Message from "primevue/message";
import { useErrorToast } from "~/composables/useErrorToast";

const { getErrorMessage } = useErrorToast();

interface LoginResponse {
	success: boolean;
	isNewAccount: boolean;
	error?: string;
}

definePageMeta({
	layout: "auth"
});

const router = useRouter();
const route = useRoute();
const { fetchUserProfile } = useUserProfile();
const { getVisitorId } = useFingerprint();

const loading = ref(false);
const username = ref("");
const password = ref("");
const errorMessage = ref<string | null>(null);
const loginURL = ref("/login");

onMounted(async () => {
	const returnTo = route.query.r as string;
	if (returnTo) {
		const params = new URLSearchParams([["r", returnTo]]);
		loginURL.value = `/login?${params.toString()}`;
	}

	try {
		if (await fetchUserProfile()) {
			// Already logged in, redirect now
			router.replace(returnTo ?? "/");
		}
	} catch {
		// Ignore
	}
});

const submit = async (e: Event) => {
	e.preventDefault();
	loading.value = true;
	errorMessage.value = null;

	try {
		const config = useRuntimeConfig();
		const { success, error } = await $fetch<LoginResponse>(`${config.public.backendUrl}/register`, {
			method: "POST",
			credentials: "include",
			body: {
				username: username.value,
				password: password.value,
				fingerprint: await getVisitorId()
			}
		});

		if (success) {
			const returnTo = route.query.r as string;
			const url = new URL("/login/discord", location.origin);
			url.searchParams.set("for", "welcome");
			if (returnTo) {
				url.searchParams.set("r", returnTo);
			}
			router.push(url.pathname + url.search);
		} else {
			throw new Error(error);
		}
	} catch (error: unknown) {
		errorMessage.value = getErrorMessage(error);
	}

	loading.value = false;
};
</script>

<style scoped>
/* */
</style>
