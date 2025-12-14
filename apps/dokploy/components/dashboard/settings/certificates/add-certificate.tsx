import { zodResolver } from "@hookform/resolvers/zod";
import { HelpCircle, Info, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";

const certificateDataHolder =
	"-----BEGIN CERTIFICATE-----\nMIIFRDCCAyygAwIBAgIUEPOR47ys6VDwMVB9tYoeEka83uQwDQYJKoZIhvcNAQELBQAwGTEXMBUGA1UEAwwObWktZG9taW5pby5jb20wHhcNMjQwMzExMDQyNzU3WhcN\n------END CERTIFICATE-----";

const privateKeyDataHolder =
	"-----BEGIN PRIVATE KEY-----\nMIIFRDCCAyygAwIBAgIUEPOR47ys6VDwMVB9tYoeEka83uQwDQYJKoZIhvcNAQELBQAwGTEXMBUGA1UEAwwObWktZG9taW5pby5jb20wHhcNMjQwMzExMDQyNzU3WhcN\n-----END PRIVATE KEY-----";

const addCertificate = z.object({
	name: z.string().min(1, "Name is required"),
	certificateData: z.string().min(1, "Certificate data is required"),
	privateKey: z.string().min(1, "Private key is required"),
	autoRenew: z.boolean().optional(),
	serverId: z.string().optional(),
});

type AddCertificate = z.infer<typeof addCertificate>;

export const AddCertificate = () => {
	const [open, setOpen] = useState(false);
	const utils = api.useUtils();

	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { mutateAsync, isError, error, isLoading } =
		api.certificates.create.useMutation();
	const { data: servers } = api.server.withSSHKey.useQuery();
	const hasServers = servers && servers.length > 0;
	// Show dropdown logic based on cloud environment
	// Cloud: show only if there are remote servers (no Dokploy option)
	// Self-hosted: show only if there are remote servers (Dokploy is default, hide if no remote servers)
	const shouldShowServerDropdown = hasServers;

	const form = useForm<AddCertificate>({
		defaultValues: {
			name: "",
			certificateData: "",
			privateKey: "",
			autoRenew: false,
		},
		resolver: zodResolver(addCertificate),
	});
	useEffect(() => {
		form.reset();
	}, [form, form.formState.isSubmitSuccessful, form.reset]);

	const onSubmit = async (data: AddCertificate) => {
		await mutateAsync({
			name: data.name,
			certificateData: data.certificateData,
			privateKey: data.privateKey,
			autoRenew: data.autoRenew,
			serverId: data.serverId === "dokploy" ? undefined : data.serverId,
			organizationId: "",
		})
			.then(async () => {
				toast.success("Certificate Created");
				await utils.certificates.all.invalidate();
				setOpen(false);
			})
			.catch(() => {
				toast.error("Error creating the Certificate");
			});
	};
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger className="" asChild>
				<Button>
					{" "}
					<PlusIcon className="h-4 w-4" />
					Add Certificate
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Add New Certificate</DialogTitle>
					<DialogDescription>
						Upload a certificate (PEM format) to secure your applications with
						HTTPS. Paste your certificate and private key below.
					</DialogDescription>
				</DialogHeader>
				{isError && <AlertBlock type="error">{error?.message}</AlertBlock>}

				<Collapsible className="mb-4">
					<CollapsibleTrigger asChild>
						<Button
							type="button"
							variant="outline"
							className="w-full justify-start"
						>
							<Info className="mr-2 h-4 w-4" />
							How to get a certificate?
						</Button>
					</CollapsibleTrigger>
					<CollapsibleContent className="mt-2 space-y-2">
						<div className="rounded-lg border bg-muted/50 p-4 text-sm">
							<p className="font-semibold mb-2">
								Option 1: Generate a self-signed certificate (for testing)
							</p>
							<pre className="bg-background p-2 rounded text-xs overflow-x-auto">
								{`openssl req -x509 -nodes -days 365 -newkey rsa:2048 \\
  -keyout privkey.key -out cert.crt \\
  -subj "/CN=yourdomain.com"`}
							</pre>
							<p className="mt-2 text-muted-foreground">
								Replace{" "}
								<code className="bg-background px-1 rounded">
									yourdomain.com
								</code>{" "}
								with your actual domain (e.g.,{" "}
								<code className="bg-background px-1 rounded">gatez.io</code>
								). Then copy the contents of{" "}
								<code className="bg-background px-1 rounded">cert.crt</code> and{" "}
								<code className="bg-background px-1 rounded">privkey.key</code>{" "}
								into the fields below.
							</p>
						</div>
						<div className="rounded-lg border bg-muted/50 p-4 text-sm">
							<p className="font-semibold mb-2">
								Option 2: Use Let's Encrypt (recommended for production)
							</p>
							<p className="text-muted-foreground">
								For production, use Let's Encrypt certificates. Dokploy can
								automatically generate and renew Let's Encrypt certificates when
								you configure domains in your applications. This manual
								certificate upload is for custom certificates.
							</p>
						</div>
						<div className="rounded-lg border bg-muted/50 p-4 text-sm">
							<p className="font-semibold mb-2">
								Option 3: Upload an existing certificate
							</p>
							<p className="text-muted-foreground">
								If you already have a certificate from a Certificate Authority
								(CA), paste the full certificate chain (including intermediate
								certificates) in the Certificate Data field, and your private
								key in the Private Key field. Both must be in PEM format.
							</p>
						</div>
					</CollapsibleContent>
				</Collapsible>

				<Form {...form}>
					<form
						id="hook-form-add-certificate"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4 "
					>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => {
								return (
									<FormItem>
										<FormLabel>Certificate Name</FormLabel>
										<FormControl>
											<Input placeholder={"gatez.io"} {...field} />
										</FormControl>
										<FormDescription>
											Use a descriptive name to identify this certificate (e.g.,
											the domain name:{" "}
											<code className="bg-background px-1 rounded">
												gatez.io
											</code>
											)
										</FormDescription>
										<FormMessage />
									</FormItem>
								);
							}}
						/>
						<FormField
							control={form.control}
							name="certificateData"
							render={({ field }) => (
								<FormItem>
									<div className="space-y-0.5">
										<FormLabel className="flex items-center gap-2">
											Certificate Data (PEM format)
											<TooltipProvider delayDuration={0}>
												<Tooltip>
													<TooltipTrigger asChild>
														<HelpCircle className="h-4 w-4 text-muted-foreground" />
													</TooltipTrigger>
													<TooltipContent className="max-w-xs">
														<p>
															Paste your certificate in PEM format. Include the
															full chain (certificate + intermediate
															certificates) if available. Must start with
															-----BEGIN CERTIFICATE----- and end with -----END
															CERTIFICATE-----.
														</p>
													</TooltipContent>
												</Tooltip>
											</TooltipProvider>
										</FormLabel>
									</div>
									<FormControl>
										<Textarea
											className="h-32 font-mono text-xs"
											placeholder={certificateDataHolder}
											{...field}
										/>
									</FormControl>
									<FormDescription>
										Paste the full certificate content including BEGIN and END
										markers
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="privateKey"
							render={({ field }) => (
								<FormItem>
									<div className="space-y-0.5">
										<FormLabel className="flex items-center gap-2">
											Private Key (PEM format)
											<TooltipProvider delayDuration={0}>
												<Tooltip>
													<TooltipTrigger asChild>
														<HelpCircle className="h-4 w-4 text-muted-foreground" />
													</TooltipTrigger>
													<TooltipContent className="max-w-xs">
														<p>
															Paste your private key in PEM format. Must start
															with -----BEGIN PRIVATE KEY----- or -----BEGIN RSA
															PRIVATE KEY----- and end with the corresponding
															END marker. Keep this secure and never share it.
														</p>
													</TooltipContent>
												</Tooltip>
											</TooltipProvider>
										</FormLabel>
									</div>
									<FormControl>
										<Textarea
											className="h-32 font-mono text-xs"
											placeholder={privateKeyDataHolder}
											{...field}
										/>
									</FormControl>
									<FormDescription>
										Paste the private key content including BEGIN and END
										markers
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						{shouldShowServerDropdown && (
							<FormField
								control={form.control}
								name="serverId"
								render={({ field }) => (
									<FormItem>
										<TooltipProvider delayDuration={0}>
											<Tooltip>
												<TooltipTrigger asChild>
													<FormLabel className="break-all w-fit flex flex-row gap-1 items-center">
														Select a Server {!isCloud && "(Optional)"}
														<HelpCircle className="size-4 text-muted-foreground" />
													</FormLabel>
												</TooltipTrigger>
											</Tooltip>
										</TooltipProvider>

										<Select
											onValueChange={field.onChange}
											defaultValue={
												field.value || (!isCloud ? "dokploy" : undefined)
											}
										>
											<SelectTrigger>
												<SelectValue
													placeholder={!isCloud ? "Dokploy" : "Select a Server"}
												/>
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													{!isCloud && (
														<SelectItem value="dokploy">
															<span className="flex items-center gap-2 justify-between w-full">
																<span>Dokploy</span>
																<span className="text-muted-foreground text-xs self-center">
																	Default
																</span>
															</span>
														</SelectItem>
													)}
													{servers?.map((server) => (
														<SelectItem
															key={server.serverId}
															value={server.serverId}
														>
															<span className="flex items-center gap-2 justify-between w-full">
																<span>{server.name}</span>
																<span className="text-muted-foreground text-xs self-center">
																	{server.ipAddress}
																</span>
															</span>
														</SelectItem>
													))}
													<SelectLabel>
														Servers ({servers?.length + (!isCloud ? 1 : 0)})
													</SelectLabel>
												</SelectGroup>
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}
					</form>

					<DialogFooter className="flex w-full flex-row !justify-end">
						<Button
							isLoading={isLoading}
							form="hook-form-add-certificate"
							type="submit"
						>
							Create
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
